// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried call is released only on proof that nothing was sent: the agent
// never accepted (its machine away), or refused before custody wrote
// anything. A request the agent took and then fell silent on may have reached
// the model, so the call is held at nothing, no reply kept, and the person
// told the answer did not finish.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { carriedWorld, type CarriedWorld } from './carried-world.ts';
import { ask, callFor, repliesTo } from './carried-schedules.ts';
import { streamedLines } from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('a carried call released or held', () => {
  let world: CarriedWorld;

  beforeEach(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('carriage_release_or_hold');
    world.ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, ['Due.']) });
  }, 180_000);

  afterEach(async () => {
    await world?.close();
    vi.unstubAllEnvs();
  });

  it.each([
    ['silent', 'MODEL_MACHINE_AWAY', false],
    ['refuse', 'MODEL_MACHINE_BUSY', true],
  ] as const)(
    'an agent that is %s: released, nothing sent, in its own words',
    async (mode, code, requested) => {
      world.agent.mode = mode;
      const body = `Due? (${mode})`;
      const events = await (await ask(world, body)).rest();
      expect(world.ollama.seen).toHaveLength(0);
      expect(await callFor(world, body)).toEqual([
        { state: 'released', offered: true, requested, actual: null },
      ]);
      expect(await repliesTo(world, body)).toBe(0);
      expect(JSON.parse(events.at(-1)?.data ?? '{}')).toMatchObject({
        reply: { answered: false, code },
      });
    },
    60_000,
  );

  it('an agent that took the request and fell silent: held at nothing, the answer did not finish', async () => {
    world.agent.mode = 'unreported';
    const body = 'Due? (silent after the request)';
    const asking = ask(world, body);
    const events = await (await asking).rest();
    world.agent.release();
    expect(world.ollama.seen).toHaveLength(1);
    expect(await callFor(world, body)).toEqual([
      { state: 'liability_unknown', offered: true, requested: true, actual: null },
    ]);
    expect(await repliesTo(world, body)).toBe(0);
    expect(JSON.parse(events.at(-1)?.data ?? '{}')).toMatchObject({ reply: { answered: false } });
  }, 60_000);
});
