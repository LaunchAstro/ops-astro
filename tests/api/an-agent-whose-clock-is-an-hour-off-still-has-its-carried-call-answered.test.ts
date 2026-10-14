// SPDX-License-Identifier: AGPL-3.0-only
//
// The send deadline is the agent's own accept plus W, so the carriage claims
// to need no agreement between the function's clock and the agent's. A real
// agent seals every message on its own clock (`expiresAt` is the sealer's
// time plus the seal's life) and opens the function's messages on that same
// clock. An agent an hour off the function, sealing and opening on its own
// clock throughout, still has its call answered: one request at Ollama, the
// call settled. With the clocks agreeing, the same script is answered.

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { carriedWorld, type CarriedWorld } from './carried-world.ts';
import { ask, callFor, repliesTo } from './carried-schedules.ts';
import { streamedLines } from './ollama-stand-in-fixture.ts';
import { answerAs, scriptedAgent, type Scripted } from './scripted-carriage-agent.ts';

const serverUrl = databaseUrlFromEnvironment();

const HOUR = 3_600_000;

describe.skipIf(serverUrl === undefined)('an agent whose clock is off', () => {
  let world: CarriedWorld;
  let agent: Scripted | undefined;

  beforeEach(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('carriage_agent_clock');
    world.ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, ['On time.']) });
  }, 180_000);

  afterEach(async () => {
    await agent?.stop();
    agent = undefined;
    await world?.close();
    vi.unstubAllEnvs();
  });

  it.each([
    ['agreeing', 0],
    ['an hour ahead', HOUR],
    ['an hour behind', -HOUR],
  ] as const)(
    'with the agent clock %s, sealing and opening on it: one request, the call settled',
    async (_name, offset) => {
      const runner = randomUUID();
      const said: unknown[] = [];
      agent = await scriptedAgent(
        world,
        async (call) => {
          await call.say('accept', { acceptedAt: call.clock() }, { runner });
          said.push(await answerAs(world, call, runner));
        },
        offset,
      );
      const body = `On time? (${String(offset)})`;
      const events = await (await ask(world, body)).rest();
      await Promise.allSettled(agent.runs);
      expect(world.ollama.seen).toHaveLength(1);
      expect(await callFor(world, body)).toMatchObject([{ state: 'settled', requested: true }]);
      expect(await repliesTo(world, body)).toBe(1);
      expect(JSON.parse(events.at(-1)?.data ?? '{}')).toMatchObject({ reply: { answered: true } });
      expect(said).toEqual(['answered']);
    },
    60_000,
  );
});
