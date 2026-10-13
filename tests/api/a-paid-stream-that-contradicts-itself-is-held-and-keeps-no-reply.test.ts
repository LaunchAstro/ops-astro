// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable max-lines-per-function -- one world, a case per way a paid stream can mislead
//
// A paid answer settles only on positive proof of what it cost and which
// model wrote it. A stream that contradicts itself is that proof's absence:
// an error the stream reported, an event from another model, a second usage
// with another cost. Each holds the most and keeps no reply. A cost above the
// hold, one that is not a number of at least nothing, or one too large to
// count is held, and the panel is answered. A positive cost is never rounded
// down to nothing. A model id outside the accepted ids is held. A stream cut
// with its headers only, mid-event, after the last words before the usage,
// or after the usage before `[DONE]` is held, never settled, with no reply
// kept. A 4xx or 5xx that echoes the key leaves no trace of it, and a send
// whose admission is lost at the handoff sends nothing, streaming or not.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { event, sse, type Answer } from './openrouter-stand-in-fixture.ts';
import {
  BEARER,
  HAIKU,
  pricedWorld,
  scopeOf,
  type PricedWorld,
} from '../broker/priced-chat-world.ts';

const serverUrl = databaseUrlFromEnvironment();

const word = (content: string, model = HAIKU) =>
  event({ id: 'gen-1', model, choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const usage = (cost: unknown, model = HAIKU) =>
  event({
    id: 'gen-1',
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 3, cost },
  });
const DONE = 'data: [DONE]\n\n';
const stream = (chunks: readonly string[], cut = false): Answer => ({ status: 200, chunks, cut });

interface Ended {
  readonly reply: unknown;
  readonly call: Record<string, unknown> | undefined;
  readonly kept: number;
}

const heldWithNothingKept = (ended: Ended, why: string): void => {
  expect(ended.reply, why).toMatchObject({ answered: false, code: 'LIABILITY_UNKNOWN' });
  expect(ended.call, why).toMatchObject({ state: 'liability_unknown' });
  expect(ended.call?.['actual_minor'], why).toBeNull();
  expect(ended.kept, why).toBe(0);
};

describe.skipIf(serverUrl === undefined)('a paid stream that contradicts itself', () => {
  let p: PricedWorld;

  beforeAll(async () => {
    p = await pricedWorld('priced_contradicts', undefined, 1, true);
    await p.setCap(1_000_000);
  }, 180_000);

  afterAll(async () => {
    await p?.stop();
  });

  const replies = async (conversationId: string): Promise<number> =>
    await p.w.count(
      `select count(*)::text as n from public.conversation_messages
        where conversation_id = $1 and role = 'agent'`,
      [conversationId],
    );

  /** The panel's answer (or what it threw), the call's row and how many replies were kept. */
  async function endsWith(answer: Answer): Promise<Ended> {
    p.openrouter.answer = () => answer;
    const asked = await p.question('What is due today?');
    const reply = await p.ask(asked).catch((error: unknown) => ({ thrown: String(error) }));
    const [call] = await p.calls(asked.conversationId);
    return { reply, call, kept: await replies(asked.conversationId) };
  }

  it('an error the stream reported, then a clean finish: held, nothing kept', async () => {
    heldWithNothingKept(
      await endsWith(
        stream([
          word('Two '),
          event({
            id: 'gen-1',
            error: { code: 502, message: 'upstream failed' },
            choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
          }),
          event({
            id: 'gen-1',
            model: HAIKU,
            error: null,
            choices: [{ index: 0, delta: { content: 'tasks.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 120, completion_tokens: 3, cost: 0.000_3 },
          }),
          DONE,
        ]),
      ),
      'an error event followed by a stop',
    );
  });

  it('words from another model, then the asked model at the finish: held, nothing kept', async () => {
    heldWithNothingKept(
      await endsWith(
        stream([
          word('Two tasks ', 'openai/gpt-9'),
          word('are due.', 'openai/gpt-9'),
          usage(0.000_3),
          DONE,
        ]),
      ),
      'a model outside the accepted ids wrote the words',
    );
  });

  it('two usage chunks, the first above the hold, the last within it: never settled at the lower', async () => {
    const ended = await endsWith(stream([word('Two tasks.'), usage(0.01), usage(0.000_3), DONE]));
    expect(ended.call?.['state']).not.toBe('settled');
    expect(ended.kept).toBe(0);
  });

  it('a positive cost far below a cent is never rounded down to nothing', async () => {
    const ended = await endsWith(stream([word('Two tasks.'), usage(1e-13), DONE]));
    expect(ended.call).toMatchObject({ state: 'settled' });
    expect(Number(ended.call?.['actual_minor'])).toBeGreaterThanOrEqual(1);
  });

  it('a cost above the hold: held at the most, the observed cost recorded, nothing kept', async () => {
    const ended = await endsWith(stream([word('Two tasks.'), usage(0.01), DONE]));
    heldWithNothingKept(ended, 'above the hold');
    expect(Number(ended.call?.['observed_minor'])).toBeGreaterThan(
      Number(ended.call?.['reserved_minor']),
    );
  });

  it.each([
    ['a string', '0.0003'],
    ['a negative number', -0.000_3],
    ['NaN, as text', 'NaN'],
    ['nothing', null],
    ['an object', { amount: 0.000_3 }],
  ])('a cost that is %s: held, nothing kept', async (name, cost) => {
    heldWithNothingKept(await endsWith(stream([word('Two tasks.'), usage(cost), DONE])), name);
  });

  it.each([
    ['the id in upper case', 'ANTHROPIC/CLAUDE-HAIKU-5.5'],
    ['a variant suffix', 'anthropic/claude-haiku-5.5:free'],
    ['a trailing space', 'anthropic/claude-haiku-5.5 '],
    ['another dated id', 'anthropic/claude-haiku-5.5-20250101'],
  ])('a model id outside the accepted ids (%s): held, nothing kept', async (name, model) => {
    heldWithNothingKept(
      await endsWith(stream([word('Two tasks.', model), usage(0.000_3, model), DONE])),
      name,
    );
  });

  it.each([
    ['headers only', stream([], true)],
    ['mid-event', stream([word('Two '), word('tasks.').slice(0, 30)], true)],
    ['after the last words, before the usage', stream([word('Two '), word('tasks.')], true)],
    ['after the usage, before [DONE]', stream([word('Two tasks.'), usage(0.000_3)], true)],
    ['ended cleanly after the usage, with no [DONE]', stream([word('Two tasks.'), usage(0.000_3)])],
    ['ended cleanly mid-event', stream([word('Two '), word('tasks.').slice(0, 30)])],
  ])('cut %s: held, never settled, nothing kept', async (name, answer) => {
    heldWithNothingKept(await endsWith(answer), name);
  });

  it.each([
    [401, 'released'],
    [402, 'released'],
    [500, 'liability_unknown'],
    [503, 'liability_unknown'],
  ])('a %d whose body echoes the key: %s, and no trace of the key', async (status, state) => {
    const ended = await endsWith({
      status,
      body: JSON.stringify({ error: { code: status, message: `invalid key ${BEARER}` } }),
    });
    expect(ended.call).toMatchObject({ state });
    expect(ended.kept).toBe(0);
    const audit = await p.w.fixture.db.admin.execute(
      'select * from public.audit_events where business_id = $1',
      [p.w.fixture.business],
    );
    expect(JSON.stringify([ended.reply, ended.call, audit])).not.toContain(BEARER);
  });

  it('a streaming send whose admission is lost at the handoff: nothing reaches OpenRouter, no piece, the hold freed', async () => {
    p.openrouter.answer = () => stream(sse(HAIKU, ['Two tasks ', 'are due today.']));
    const asked = await p.question('What is due today?');
    const before = p.openrouter.received.length;
    const heard: string[] = [];
    const { db, business } = p.w.fixture;
    const result = await p.direct({
      ...scopeOf(p, asked),
      onPiece: (text) => heard.push(text),
      paid: {
        authors: [p.owner.actorId],
        asCaller: async (work) =>
          await db.app.withBusiness(
            business,
            async (tx) =>
              await work(tx, {
                stillAdmitted: async () => await Promise.resolve(false),
                keep: async () => await Promise.resolve(true),
              }),
          ),
      },
    });
    expect(result).toMatchObject({ ok: false });
    expect(p.openrouter.received.length).toBe(before);
    expect(heard).toStrictEqual([]);
    expect(await p.calls(asked.conversationId)).toMatchObject([{ state: 'released' }]);
  });

  it('a cost too large to count: held, and the panel is answered', async () => {
    heldWithNothingKept(
      await endsWith(stream([word('Two tasks.'), usage(1e308), DONE])),
      'a cost of 1e308 US dollars',
    );
    // The person's next paid message is answered: the held call does not keep the route's one slot.
    p.openrouter.answer = () => stream(sse(HAIKU, ['Two tasks.']));
    const next = await p.question('And tomorrow?');
    expect(await p.ask(next)).toMatchObject({ answered: true });
  });
});
