// SPDX-License-Identifier: AGPL-3.0-only
//
// Once the function's send judgement passes, its locks hold until the model
// agent reports the write, or W after the accept was heard. With the real
// agent and custody: a revocation started while the agent holds the request
// commits only after custody wrote it to Ollama. When the agent pauses past
// the deadline before custody, the revocation commits once W has passed,
// and custody, the deadline gone, writes nothing: Ollama is asked nothing
// and the call is released.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEND_WINDOW_MS } from '../../packages/core-custody/src/agent.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { latch } from '../support/lock-wait-race.ts';
import { carriedWorld, type CarriedWorld } from './carried-world.ts';
import { ask, callFor, repliesTo, revokeOwn } from './carried-schedules.ts';
import { withModelAgent, type CarriedAgent } from './model-agent-carried.ts';
import { streamedLines } from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const WORDS = ['Two ', 'tasks ', 'are ', 'due.'];

// oxlint-disable-next-line max-lines-per-function -- one carried world per case
describe.skipIf(serverUrl === undefined)('a revocation during the send', () => {
  let world: CarriedWorld;
  let carried: CarriedAgent | undefined;

  beforeEach(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('model_agent_send_fence');
    world.ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS) });
  }, 180_000);

  afterEach(async () => {
    await carried?.stop();
    carried = undefined;
    await world?.close();
    vi.unstubAllEnvs();
  });

  const revoke = async (): Promise<number> => {
    await world.database.withBusiness(world.w.fixture.business, async (tx) => {
      await revokeOwn(world, tx);
    });
    return Date.now();
  };

  it('waits for custody to write the chat to Ollama, then commits', async () => {
    const handed = latch();
    const go = latch();
    let writtenAt = Number.POSITIVE_INFINITY;
    carried = await withModelAgent(world, (custody) => ({
      dispatch: async (request, gate, onPiece) => {
        handed.open();
        await go.promise;
        const onWritten = (): void => {
          writtenAt = Date.now();
          gate.onWritten();
        };
        return await custody.dispatch(request, { ...gate, onWritten }, onPiece);
      },
    }));
    const body = 'What is due? (written)';
    const asking = ask(world, body);
    await Promise.race([handed.promise, sleep(8_000)]);
    const committed = revoke();
    await sleep(300);
    expect(world.ollama.seen).toHaveLength(0);
    go.open();
    const committedAt = await committed;
    // Custody wrote the chat before the revocation could commit.
    expect(committedAt).toBeGreaterThanOrEqual(writtenAt);
    await world.ollama.arrived(1);
    expect(world.ollama.seen).toHaveLength(1);
    await (await asking).rest();
    expect(await callFor(world, body)).toMatchObject([{ requested: true }]);
  }, 60_000);

  it('an agent paused past the deadline lets the revocation commit at W and writes nothing', async () => {
    const handed = latch();
    carried = await withModelAgent(world, (custody) => ({
      dispatch: async (request, gate, onPiece) => {
        handed.open();
        await sleep(SEND_WINDOW_MS + 500);
        return await custody.dispatch(request, gate, onPiece);
      },
    }));
    const body = 'What is due? (paused)';
    const asking = ask(world, body);
    await Promise.race([handed.promise, sleep(8_000)]);
    const startedAt = Date.now();
    const waited = (await revoke()) - startedAt;
    expect(waited).toBeGreaterThanOrEqual(SEND_WINDOW_MS - 1_000);
    expect(waited).toBeLessThan(SEND_WINDOW_MS + 2_000);
    const events = await (await asking).rest();
    expect(world.ollama.seen).toHaveLength(0);
    expect(await callFor(world, body)).toEqual([
      { state: 'released', offered: true, requested: true, actual: null },
    ]);
    expect(await repliesTo(world, body)).toBe(0);
    expect(JSON.parse(events.at(-1)?.data ?? '{}')).toMatchObject({ reply: { answered: false } });
  }, 60_000);
});
