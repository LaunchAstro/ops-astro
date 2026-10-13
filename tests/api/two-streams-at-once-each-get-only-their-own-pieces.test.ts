// SPDX-License-Identifier: AGPL-3.0-only
//
// Two people's answers written at the same moment through one server and one
// custody: each stream carries only its own pieces, numbered from 0 without a
// gap, and its own outcome. Two businesses answer side by side; in one
// business a second person's message while the first is answered waits its
// turn (one answer at a time on this machine) and gets none of the first
// person's words.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { createApiFixture } from './fixture.ts';
import {
  ollamaBroker,
  standInOllama,
  streamedLines,
  type StandIn,
} from './ollama-stand-in-fixture.ts';
import { sendStreaming, type StreamEvent } from './streamed-reply-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const ALPHA = ['Alpha ', 'has ', 'two ', 'tasks ', 'due.'];
const BETA = ['Beta ', 'owes ', 'three ', 'invoices ', 'now.'];

const piecesOf = (events: readonly StreamEvent[]): readonly StreamEvent[] =>
  events.filter((event) => event.event === 'piece');

const outcomeOf = (events: readonly StreamEvent[]): Record<string, unknown> => {
  const last = events.at(-1);
  expect(last?.event).toBe('outcome');
  return JSON.parse(last?.data ?? '{}') as Record<string, unknown>;
};

// oxlint-disable-next-line max-lines-per-function -- one stand-in, one broker and two worlds
describe.skipIf(serverUrl === undefined)('two streams at once', () => {
  let ollama: StandIn;
  let broker: Awaited<ReturnType<typeof ollamaBroker>>;
  let alpha: ConversationWorld;
  let beta: ConversationWorld;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    ollama = await standInOllama();
    broker = await ollamaBroker(ollama.origin, 'none');
    const one = await createApiFixture('two_streams_alpha');
    alpha = await conversationWorld({ fixture: one, api: composedWith(one, broker.exchange) });
    const two = await createApiFixture('two_streams_beta');
    beta = await conversationWorld({ fixture: two, api: composedWith(two, broker.exchange) });
  }, 240_000);

  afterAll(async () => {
    await broker?.stop();
    await ollama?.close();
    await alpha?.drop();
    await beta?.drop();
    vi.unstubAllEnvs();
  });

  /** Each request, in the order it reaches the stand-in, gets the next of `answers`. */
  function inTurn(answers: readonly (readonly string[])[]): void {
    let next = 0;
    ollama.reply = (model) => {
      const words = answers[next] ?? ['Nothing.'];
      next += 1;
      return { status: 200, chunks: streamedLines(model, words), holdAfter: 2 };
    };
  }

  it('two businesses: each stream gets only its own pieces, in order, and its own outcome', async () => {
    inTurn([ALPHA, BETA]);
    const before = ollama.seen.length;
    const first = await sendStreaming(alpha.api, alpha.owner, 'conversation.start', {
      body: 'What is due for Alpha?',
    });
    await ollama.arrived(before + 1);
    const second = await sendStreaming(beta.api, beta.owner, 'conversation.start', {
      body: 'What is owed to Beta?',
    });
    await ollama.arrived(before + 2);
    // Both are held mid-answer, two lines written each; let both write the rest at once.
    ollama.resume();
    const [one, two] = await Promise.all([first.rest(), second.rest()]);
    expect(piecesOf(one).map((event) => event.data)).toEqual(ALPHA);
    expect(piecesOf(two).map((event) => event.data)).toEqual(BETA);
    expect(piecesOf(one).map((event) => event.id)).toEqual(['0', '1', '2', '3', '4']);
    expect(piecesOf(two).map((event) => event.id)).toEqual(['0', '1', '2', '3', '4']);
    expect(outcomeOf(one)).toMatchObject({ reply: { answered: true, body: ALPHA.join('') } });
    expect(outcomeOf(two)).toMatchObject({ reply: { answered: true, body: BETA.join('') } });
    // The outcome is last: no piece after it.
    expect(one.findIndex((event) => event.event === 'outcome')).toBe(one.length - 1);
    expect(two.findIndex((event) => event.event === 'outcome')).toBe(two.length - 1);
  }, 60_000);

  it('one business: a second person waits their turn and gets none of the first person’s words', async () => {
    inTurn([ALPHA, BETA]);
    const before = ollama.seen.length;
    const first = await sendStreaming(alpha.api, alpha.owner, 'conversation.start', {
      body: 'What is due?',
    });
    await ollama.arrived(before + 1);
    await ollama.midway();
    const second = await sendStreaming(alpha.api, alpha.colleague, 'conversation.start', {
      body: 'What is mine?',
    });
    const two = await second.rest();
    ollama.resume();
    const one = await first.rest();
    expect(piecesOf(one).map((event) => event.data)).toEqual(ALPHA);
    expect(piecesOf(two)).toEqual([]);
    expect(outcomeOf(two)).toMatchObject({ reply: { answered: false, code: 'RATE_LIMITED' } });
    expect(JSON.stringify(two)).not.toContain('Alpha');
    expect(ollama.seen.length - before).toBe(1);
  }, 60_000);
});
