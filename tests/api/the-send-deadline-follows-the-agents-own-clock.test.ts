// SPDX-License-Identifier: AGPL-3.0-only
//
// The send deadline needs no agreement between clocks: it is the agent's own
// accept, on its own clock, plus the send window (three seconds), carried
// sealed in the request, and checked by the agent against that same clock. A
// machine whose clock is an hour off its function's still gets a request it
// may send, with a deadline three seconds after its own accept.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEND_WINDOW_MS } from '../../packages/core-custody/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { carriedWorld, type CarriedWorld } from './carried-world.ts';
import { ask, callFor } from './carried-schedules.ts';
import { streamedLines } from './ollama-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('the send deadline', () => {
  let world: CarriedWorld;

  beforeEach(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('carriage_deadline');
    world.ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, ['Due.']) });
  }, 180_000);

  afterEach(async () => {
    await world?.close();
    vi.unstubAllEnvs();
  });

  it.each([0, 3_600_000, -3_600_000])(
    'with the agent clock %i ms off: the deadline is its accept plus W, and the request is sent',
    async (offset) => {
      world.agent.clockOffset = offset;
      const body = `Due? (${String(offset)})`;
      await (await ask(world, body)).rest();
      const [request] = world.agent.requests;
      expect(request).toBeDefined();
      const accepted = (request?.deadlineAt ?? 0) - SEND_WINDOW_MS;
      // Its own accept, on its own clock: within the time it took the request to come.
      expect(accepted).toBeLessThanOrEqual(request?.heardAt ?? 0);
      expect((request?.heardAt ?? 0) - accepted).toBeLessThan(SEND_WINDOW_MS);
      expect(world.agent.sent).toHaveLength(1);
      expect(await callFor(world, body)).toMatchObject([{ state: 'settled', requested: true }]);
    },
    60_000,
  );
});
