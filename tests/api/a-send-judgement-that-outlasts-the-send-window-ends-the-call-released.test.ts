// SPDX-License-Identifier: AGPL-3.0-only
//
// A send judgement that waits on its locks past the send window: the request
// then reaches the agent after its deadline, and the agent refuses it, sealed,
// with `SEND_LAPSED`. Custody wrote nothing, so the function releases the call
// and the person is told nothing was sent. Taken for silence, the call would
// be held though it provably asked the model nothing.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEND_WINDOW_MS } from '../../packages/core-custody/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { carriedWorld, type CarriedWorld } from './carried-world.ts';
import { ask, callFor, holdAgent, judgementWaits, repliesTo } from './carried-schedules.ts';
import { streamedLines } from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('a send judgement past the send window', () => {
  let world: CarriedWorld;

  beforeEach(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('carriage_send_outlasts');
    world.ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, ['Due.']) });
  }, 180_000);

  afterEach(async () => {
    await world?.close();
    vi.unstubAllEnvs();
  });

  it('ends the call released, nothing sent, in its own words', async () => {
    let holding: Promise<void> = Promise.resolve();
    // Taken at the agent's accept, after the offer: the send judgement waits on it.
    world.agent.beforeAccept = async () => {
      const held = await holdAgent(world);
      holding = (async () => {
        await judgementWaits(world, held);
        // The window is a time bound: the hold outlasts it, then lets the judgement pass.
        await sleep(SEND_WINDOW_MS + 500);
        await held.letGo();
      })();
    };
    // The refusal comes a moment after the request has gone, as it can over a real socket.
    world.agent.beforeLapse = async () => await sleep(200);
    const body = 'What is due? (judged past the window)';
    const events = await (await ask(world, body)).rest();
    await holding;
    expect(world.ollama.seen).toHaveLength(0);
    expect(world.agent.sent).toHaveLength(0);
    expect(await repliesTo(world, body)).toBe(0);
    expect(await callFor(world, body)).toEqual([
      { state: 'released', offered: true, requested: true, actual: null },
    ]);
    expect(JSON.parse(events.at(-1)?.data ?? '{}')).toMatchObject({
      reply: { answered: false, code: 'SEND_LAPSED' },
    });
  }, 60_000);
});
