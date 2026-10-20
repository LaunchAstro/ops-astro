// SPDX-License-Identifier: AGPL-3.0-only
//
// The side panel on Ollama, through the server's own composition root, asking
// for its answer as an event stream. Pieces of the answer arrive while Ollama
// is still writing, each a display text in order; then one `outcome` event
// carries exactly the JSON body the same request answers without a stream. A
// request that does not ask for a stream is answered in JSON as before. A
// stream Ollama breaks off keeps no reply, and its outcome says so in fixed
// words. A refused command is refused in JSON, with no stream opened.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { authorised, createApiFixture, tokenFor } from './fixture.ts';
import { personPath } from './controls-fixture.ts';
import {
  ollamaBroker,
  standInOllama,
  streamedLines,
  type StandIn,
} from './ollama-stand-in-fixture.ts';
import { openedWhileWriting, sendStreaming, type StreamEvent } from './streamed-reply-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const WORDS = ['Two ', 'tasks ', 'are ', 'due ', 'today.'];

const pieces = (events: readonly StreamEvent[]): string =>
  events
    .filter((event) => event.event === 'piece')
    .map((event) => event.data)
    .join('');

// oxlint-disable-next-line max-lines-per-function -- one stand-in, one broker and one world
describe.skipIf(serverUrl === undefined)('the side panel streams the answer word by word', () => {
  let ollama: StandIn;
  let broker: Awaited<ReturnType<typeof ollamaBroker>>;
  let w: ConversationWorld;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    ollama = await standInOllama();
    broker = await ollamaBroker(ollama.origin, 'none');
    const fixture = await createApiFixture('side_panel_streams');
    w = await conversationWorld({ fixture, api: composedWith(fixture, broker.exchange) });
  }, 180_000);

  afterAll(async () => {
    await broker?.stop();
    await ollama?.close();
    await w?.drop();
    vi.unstubAllEnvs();
  });

  const agentReplies = async (conversationId: string): Promise<number> =>
    await w.count(
      `select count(*)::text as n from public.conversation_messages
        where conversation_id = $1 and role = 'agent'`,
      [conversationId],
    );

  async function conversation(): Promise<string> {
    ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, ['Hello.']) });
    const opened = await w.as(w.owner, 'conversation.start', { body: 'Hello?' });
    return String(detail(opened)['conversationId']);
  }

  // oxlint-disable-next-line max-lines-per-function -- one held answer read through to its outcome
  it('sends pieces while Ollama still writes, then the outcome the JSON body would be', async () => {
    const conversationId = await conversation();
    ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS), holdAfter: 3 });
    const operationId = crypto.randomUUID();
    const body = { conversationId, body: 'What is due today?', operationId };
    const sending = sendStreaming(w.api, w.owner, 'conversation.message', body);
    await ollama.midway();
    // Ollama is holding after three words: the stream is open and its first pieces are here.
    const opened = await openedWhileWriting(sending);
    if (opened === undefined) ollama.resume();
    expect(opened, 'the stream opens while Ollama is still writing').toBeDefined();
    const streaming = opened as NonNullable<typeof opened>;
    expect(streaming.status).toBe(200);
    expect(streaming.contentType).toMatch(/^text\/event-stream/u);
    const early: StreamEvent[] = [];
    while (pieces(early) !== 'Two tasks are ') {
      // oxlint-disable-next-line no-await-in-loop -- reads the pieces as they arrive
      const event = await streaming.next();
      if (event === undefined) throw new Error('the stream ended before its first pieces');
      early.push(event);
    }
    expect(early.every((event) => event.event === 'piece')).toBe(true);
    expect(early.map((event) => event.id)).toStrictEqual(early.map((_event, at) => String(at)));
    ollama.resume();
    const rest = await streaming.rest();
    expect(pieces([...early, ...rest])).toBe('Two tasks are due today.');
    const outcome = rest.at(-1);
    expect(outcome?.event).toBe('outcome');
    expect(rest.filter((event) => event.event === 'outcome')).toHaveLength(1);
    expect(JSON.parse(outcome?.data ?? '{}')).toMatchObject({
      reply: { answered: true, body: 'Two tasks are due today.' },
    });
    // The same request again, without a stream: the reply the replay answers.
    const replay = await w.api.fetch(
      new Request(`http://api.test${personPath('conversation.message')}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...authorised(await tokenFor(w.owner.presented.subject)),
        },
        body: JSON.stringify(body),
      }),
    );
    expect(replay.headers.get('content-type')).toMatch(/^application\/json/u);
    const streamed = JSON.parse(outcome?.data ?? '{}') as Record<string, unknown>;
    const replayed = JSON.parse(await replay.text()) as Record<string, unknown>;
    expect(streamed['reply']).toStrictEqual(replayed['reply']);
    // And a new message without a stream: the same body, key for key.
    ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS) });
    const plain = await w.as(w.owner, 'conversation.message', { conversationId, body: 'And?' });
    expect(Object.keys(streamed)).toStrictEqual(Object.keys(plain.body));
    expect(Object.keys(streamed['reply'] as object)).toStrictEqual(
      Object.keys(plain.body['reply'] as object),
    );
    expect(ollama.seen.filter((seen) => seen.last === 'What is due today?')).toHaveLength(1);
    expect(ollama.seen.map((seen) => seen.authorization)).not.toContain(expect.anything());
  }, 60_000);

  it('answers in JSON as before when no stream is asked for', async () => {
    const conversationId = await conversation();
    ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS) });
    const answer = await w.as(w.owner, 'conversation.message', { conversationId, body: 'Due?' });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      reply: { answered: true, body: 'Two tasks are due today.' },
    });
  }, 60_000);

  it('a stream Ollama breaks off keeps no reply, and the outcome says it could not be used', async () => {
    const conversationId = await conversation();
    ollama.reply = (model) => ({
      status: 200,
      chunks: streamedLines(model, WORDS).slice(0, 2),
      cut: true,
    });
    const streaming = await sendStreaming(w.api, w.owner, 'conversation.message', {
      conversationId,
      body: 'Anything overdue?',
    });
    const events = await streaming.rest();
    expect(pieces(events)).toBe('Two tasks ');
    const outcome = events.at(-1);
    expect(outcome?.event).toBe('outcome');
    expect(JSON.parse(outcome?.data ?? '{}')).toMatchObject({ reply: { answered: false } });
    expect(await agentReplies(conversationId)).toBe(1);
  }, 60_000);

  it('a refused command is refused in JSON, and no stream is opened', async () => {
    const before = ollama.seen.length;
    const streaming = await sendStreaming(w.api, w.colleague, 'conversation.message', {
      conversationId: '00000000-0000-4000-8000-000000000000',
      body: 'Not mine',
    });
    expect(streaming.contentType).toMatch(/^application\/json/u);
    expect(JSON.parse(await streaming.text())).toMatchObject({ refused: true });
    expect(ollama.seen).toHaveLength(before);
  }, 60_000);
});
