// SPDX-License-Identifier: AGPL-3.0-only
//
// Every agent message on a call's line is sealed under the carry key, which
// any agent process holds. What a genuine seal may still not do:
//
// - A second runner's accept, after the first: the request is sealed for the
//   first runner alone, and the second's `written` and answer move nothing.
// - An answer sealed for another call, for this call's id in capitals, or
//   past its seal's life: none settles; the runner's own answer does.
// - An accept sealed for another call, for the id in capitals, or past its
//   life: none is an accept, so nothing is sent and the call is released.
// - An accept whose runner is written in capitals: the runner is a uuid, so
//   the call either goes on as that runner or is refused whole; either way
//   it never ends held, and Ollama is asked at most once.

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { carriedWorld, type CarriedWorld } from './carried-world.ts';
import { ask, callFor, repliesTo } from './carried-schedules.ts';
import { streamedLines } from './ollama-stand-in-fixture.ts';
import {
  answerAs,
  scriptedAgent,
  type CallLine,
  type Scripted,
} from './scripted-carriage-agent.ts';

const serverUrl = databaseUrlFromEnvironment();

const RIGHT = 'Right runner.';
const WRONG = 'Wrong.';

/** An answer whose body is a whole Ollama stream of `words`. */
const answerOf = (model: string, words: readonly string[]) => ({
  kind: 'answered',
  outbound: { ok: true, status: 200, body: streamedLines(model, words).join('') },
  credentialKind: 'api_key',
  account: null,
});

const outcome = (events: readonly { readonly data: string }[]) =>
  JSON.parse(events.at(-1)?.data ?? '{}') as Record<string, unknown>;

// oxlint-disable-next-line max-lines-per-function -- one carried world per case
describe.skipIf(serverUrl === undefined)('sealed messages that do not belong', () => {
  let world: CarriedWorld;
  let agent: Scripted | undefined;

  beforeEach(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('carriage_foreign_seals');
    world.ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, [RIGHT]) });
  }, 180_000);

  afterEach(async () => {
    await agent?.stop();
    agent = undefined;
    await world?.close();
    vi.unstubAllEnvs();
  });

  it("two runners accept: the request is the first's, the second's write and answer move nothing", async () => {
    const first = randomUUID();
    const second = randomUUID();
    agent = await scriptedAgent(world, async (call) => {
      await call.say('accept', { acceptedAt: call.clock() }, { runner: first });
      await call.say('accept', { acceptedAt: call.clock() }, { runner: second });
      const theirs = await call.request(first);
      expect(await call.request(second, 500)).toBeUndefined();
      const model = String((JSON.parse(theirs?.request.body ?? '{}') as { model?: unknown }).model);
      await call.say('written', {}, { runner: second });
      await call.say('answer', answerOf(model, [WRONG]), { runner: second });
      // The first runner then plays its part whole.
      await answerFrom(world, call, first, theirs !== undefined);
    });
    const body = 'Which runner?';
    const events = await (await ask(world, body)).rest();
    await Promise.all(agent.runs);
    expect(world.ollama.seen).toHaveLength(1);
    expect(await callFor(world, body)).toMatchObject([{ state: 'settled', requested: true }]);
    expect(outcome(events)).toMatchObject({ reply: { answered: true, body: RIGHT } });
  }, 60_000);

  it.each(['another call', 'the id in capitals', 'a seal past its life'] as const)(
    'an answer sealed for %s settles nothing; the runner’s own answer does',
    async (wrong) => {
      const runner = randomUUID();
      agent = await scriptedAgent(world, async (call) => {
        await call.say('accept', { acceptedAt: call.clock() }, { runner });
        const asked = await call.request(runner);
        const model = String(
          (JSON.parse(asked?.request.body ?? '{}') as { model?: unknown }).model,
        );
        await call.say('written', {}, { runner });
        const as = {
          runner,
          ...(wrong === 'another call' ? { k: randomUUID() } : {}),
          ...(wrong === 'the id in capitals' ? { k: call.k.toUpperCase() } : {}),
          ...(wrong === 'a seal past its life' ? { expiresAt: call.clock() - 1 } : {}),
        };
        await call.say('answer', answerOf(model, [WRONG]), as);
        await call.say('refused', { code: 'MODEL_MACHINE_BUSY' }, as);
        await answerFrom(world, call, runner, asked !== undefined);
      });
      const body = `Whose answer? (${wrong})`;
      const events = await (await ask(world, body)).rest();
      await Promise.all(agent.runs);
      expect(await callFor(world, body)).toMatchObject([{ state: 'settled' }]);
      expect(outcome(events)).toMatchObject({ reply: { answered: true, body: RIGHT } });
      expect(await repliesTo(world, body)).toBe(1);
    },
    60_000,
  );

  it.each(['another call', 'the id in capitals', 'a seal past its life'] as const)(
    'an accept sealed for %s is no accept: nothing sent, released',
    async (wrong) => {
      const runner = randomUUID();
      agent = await scriptedAgent(world, async (call) => {
        const as = {
          runner,
          ...(wrong === 'another call' ? { k: randomUUID() } : {}),
          ...(wrong === 'the id in capitals' ? { k: call.k.toUpperCase() } : {}),
          ...(wrong === 'a seal past its life' ? { expiresAt: call.clock() - 1 } : {}),
        };
        await call.say('accept', { acceptedAt: call.clock() }, as);
        return await call.request(runner, 6_000);
      });
      const body = `Accepted? (${wrong})`;
      const events = await (await ask(world, body)).rest();
      expect(await Promise.all(agent.runs)).toEqual([undefined]);
      expect(world.ollama.seen).toHaveLength(0);
      expect(await callFor(world, body)).toEqual([
        { state: 'released', offered: true, requested: false, actual: null },
      ]);
      expect(outcome(events)).toMatchObject({ reply: { answered: false } });
    },
    60_000,
  );

  it('an accept whose runner is in capitals: carried as that runner or refused whole, never held', async () => {
    const runner = randomUUID().toUpperCase();
    const said: unknown[] = [];
    agent = await scriptedAgent(world, async (call) => {
      await call.say('accept', { acceptedAt: call.clock() }, { runner });
      said.push(await answerAs(world, call, runner));
    });
    const body = 'Capital runner?';
    const events = await (await ask(world, body)).rest();
    await Promise.all(agent.runs);
    const [row] = await callFor(world, body);
    expect(world.ollama.seen.length).toBeLessThanOrEqual(1);
    if (said[0] === 'answered') {
      expect(row).toMatchObject({ state: 'settled' });
      expect(outcome(events)).toMatchObject({ reply: { answered: true, body: RIGHT } });
    } else {
      expect(world.ollama.seen).toHaveLength(0);
      expect(row).toMatchObject({ state: 'released' });
      expect(outcome(events)).toMatchObject({ reply: { answered: false } });
    }
  }, 60_000);
});

/** The runner's own part once its request came: asked of Ollama, written, answered. */
async function answerFrom(
  world: CarriedWorld,
  call: CallLine,
  runner: string,
  requested: boolean,
): Promise<void> {
  if (!requested) throw new Error('the runner had no request');
  // The request was already heard; `answerAs` opens it again from what the line delivered.
  expect(await answerAs(world, call, runner)).toBe('answered');
}
