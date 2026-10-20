// SPDX-License-Identifier: AGPL-3.0-only
//
// Paid chat end to end on a carried deployment: the person picks the paid
// model in the side panel, the function holds the reply's most against the
// chat budget, offers the call, and the model agent's custody presents its
// own OpenRouter key to the stand-in OpenRouter. Custody decodes the stream,
// so the first words reach the panel while OpenRouter is still writing; the
// reply is kept and the call settled at the cost OpenRouter reported, the
// rest of the hold freed.
//
// The carried call's endings hold for a paid call too, with the whole hold:
// no request sent (the agent away, or refusing before it writes) releases it
// and frees every cent; a request the agent took and then fell silent on may
// have reached OpenRouter, so the call is held at its most.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { carriedWorld, PAID_HOLD, type CarriedWorld } from './carried-world.ts';
import { ask, callFor, heldFor, repliesTo } from './carried-schedules.ts';
import { AGENT_BEARER, withModelAgent, type CarriedAgent } from './model-agent-carried.ts';
import { HAIKU, sse } from './openrouter-stand-in-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const LONG = 'Two tasks are due today, and both are small enough to finish this morning. ';
/** Words past what custody holds back (the key's longest spelling) before the stand-in pauses. */
const WORDS = [LONG.repeat(2), LONG.repeat(2), 'Then lunch.', ' Done.'];
/** OpenRouter's reported cost, US dollars: AUD 0.08 at the fixed rate, rounded up. */
const COST = 0.05;
const COST_MINOR = 8;

// oxlint-disable-next-line max-lines-per-function -- the world and its one journey
describe.skipIf(serverUrl === undefined)('a paid reply through the model agent', () => {
  let world: CarriedWorld;
  let carried: CarriedAgent;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('paid_carried_end_to_end', undefined, {}, true);
    carried = await withModelAgent(world);
  }, 180_000);

  afterAll(async () => {
    await carried?.stop();
    await world?.close();
    vi.unstubAllEnvs();
  });

  it('streams the first decoded words while OpenRouter writes, then keeps the reply settled at its cost', async () => {
    const openrouter = world.openrouter;
    if (openrouter === undefined) throw new Error('the world has no stand-in OpenRouter');
    openrouter.answer = (request) => ({
      status: 200,
      chunks: sse(String(request.body['model']), WORDS, COST),
      holdAfter: 3,
    });
    const body = 'What is due today, on the paid model?';
    const streaming = await ask(world, body, undefined, undefined, HAIKU);
    await Promise.race([openrouter.midway(), sleep(8_000)]);
    const first = await streaming.next();
    expect(first?.event).toBe('piece');
    expect(WORDS.join('').startsWith(first?.data ?? '-')).toBe(true);
    expect(await repliesTo(world, body)).toBe(0);
    openrouter.resume();
    const events = [first, ...(await streaming.rest())];
    const shown = events
      .filter((event) => event?.event === 'piece')
      .map((event) => event?.data ?? '')
      .join('');
    expect(shown).toBe(WORDS.join(''));
    expect(JSON.parse(events.at(-1)?.data ?? '{}')).toMatchObject({ reply: { answered: true } });
    expect(openrouter.received).toHaveLength(1);
    expect(openrouter.received[0]?.authorization).toBe(`Bearer ${AGENT_BEARER}`);
    expect(openrouter.received[0]?.body['model']).toBe(HAIKU);
    expect(world.ollama.seen).toHaveLength(0);
    expect(world.agent.sent).toHaveLength(0);
    expect(await repliesTo(world, body)).toBe(1);
    expect(await callFor(world, body)).toEqual([
      { state: 'settled', offered: true, requested: true, actual: COST_MINOR },
    ]);
    expect(await heldFor(world, body)).toEqual([{ reserved: PAID_HOLD, committed: COST_MINOR }]);
  }, 60_000);
});

describe.skipIf(serverUrl === undefined)('a paid carried call released or held', () => {
  let world: CarriedWorld;

  beforeEach(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('paid_carried_release_or_hold', undefined, {}, true);
  }, 180_000);

  afterEach(async () => {
    await world?.close();
    vi.unstubAllEnvs();
  });

  it.each([
    ['silent', 'MODEL_MACHINE_AWAY', false],
    ['refuse', 'MODEL_MACHINE_BUSY', true],
  ] as const)(
    'an agent that is %s: released, nothing sent, the whole hold freed',
    async (mode, code, requested) => {
      world.agent.mode = mode;
      const body = `Due, paid? (${mode})`;
      const events = await (await ask(world, body, undefined, undefined, HAIKU)).rest();
      expect(world.openrouter?.received).toHaveLength(0);
      expect(await callFor(world, body)).toEqual([
        { state: 'released', offered: true, requested, actual: null },
      ]);
      expect(await heldFor(world, body)).toEqual([{ reserved: PAID_HOLD, committed: 0 }]);
      expect(await repliesTo(world, body)).toBe(0);
      expect(JSON.parse(events.at(-1)?.data ?? '{}')).toMatchObject({
        reply: { answered: false, code },
      });
    },
    60_000,
  );

  it('an agent that took the request and fell silent: held at the most, no reply kept', async () => {
    world.agent.mode = 'unreported';
    const body = 'Due, paid? (silent after the request)';
    const events = await (await ask(world, body, undefined, undefined, HAIKU)).rest();
    world.agent.release();
    expect(world.openrouter?.received).toHaveLength(1);
    expect(await callFor(world, body)).toEqual([
      { state: 'liability_unknown', offered: true, requested: true, actual: null },
    ]);
    expect(await heldFor(world, body)).toEqual([{ reserved: PAID_HOLD, committed: PAID_HOLD }]);
    expect(await repliesTo(world, body)).toBe(0);
    expect(JSON.parse(events.at(-1)?.data ?? '{}')).toMatchObject({ reply: { answered: false } });
  }, 60_000);
});
