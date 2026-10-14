// SPDX-License-Identifier: AGPL-3.0-only
//
// An offer judgement that waits on its locks longer than a seal lives, on
// clocks that agree. The wait is the function's, not the agent's clock
// running ahead: the agent's seals made after the offer are live, and its
// answer is heard, settled at nothing and kept.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEAL_LIFE_MS } from '../../packages/core-custody/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { carriedWorld, type CarriedWorld } from './carried-world.ts';
import { ask, callFor, holdAgent, judgementWaits, repliesTo } from './carried-schedules.ts';
import { streamedLines } from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('an offer judgement past a seal’s life', () => {
  let world: CarriedWorld;

  beforeEach(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('carriage_offer_waits');
    world.ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, ['Due.']) });
  }, 180_000);

  afterEach(async () => {
    await world?.close();
    vi.unstubAllEnvs();
  });

  it('has its answer heard, settled and kept', async () => {
    let holding: Promise<void> = Promise.resolve();
    // Taken as the function joins the call's line, before the offer: the offer judgement waits on it.
    world.beforeJoin.run = async () => {
      const held = await holdAgent(world);
      holding = (async () => {
        await judgementWaits(world, held);
        // A seal's life is a time bound: the wait outlasts it, then lets the judgement pass.
        await sleep(SEAL_LIFE_MS + 1_000);
        await held.letGo();
      })();
    };
    const body = 'What is due? (offer judged after a long wait)';
    const events = await (await ask(world, body)).rest();
    await holding;
    expect(JSON.parse(events.at(-1)?.data ?? '{}')).toMatchObject({
      reply: { answered: true, body: 'Due.' },
    });
    expect(world.ollama.seen).toHaveLength(1);
    expect(await repliesTo(world, body)).toBe(1);
    expect(await callFor(world, body)).toEqual([
      { state: 'settled', offered: true, requested: true, actual: 0 },
    ]);
  }, 120_000);
});
