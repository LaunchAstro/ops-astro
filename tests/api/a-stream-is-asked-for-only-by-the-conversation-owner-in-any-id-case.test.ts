// SPDX-License-Identifier: AGPL-3.0-only
//
// The event stream answers only the conversation's owner, in the business the
// path names. Another person's message to the owner's conversation, in either
// id case, and a path naming another business, are refused in JSON with no
// stream and no piece, and Ollama is not asked. An owner who writes the
// conversation id in upper case gets the same stream; a repeat of that
// message written in lower case, while the first is answered, waits for it,
// so Ollama is asked once and one reply is kept.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { conversationWorld, detail, started, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { authorised, createApiFixture, post, tokenFor } from './fixture.ts';
import { personPath } from './controls-fixture.ts';
import {
  ollamaBroker,
  standInOllama,
  streamedLines,
  type StandIn,
} from './ollama-stand-in-fixture.ts';
import { sendStreaming, type StreamEvent } from './streamed-reply-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const WORDS = ['Two ', 'tasks ', 'are ', 'due ', 'today.'];
const ANSWER = 'Two tasks are due today.';

const outcomeOf = (events: readonly StreamEvent[]): Record<string, unknown> => {
  const last = events.at(-1);
  expect(last?.event).toBe('outcome');
  return JSON.parse(last?.data ?? '{}') as Record<string, unknown>;
};

// oxlint-disable-next-line max-lines-per-function -- one stand-in, one broker and one world
describe.skipIf(serverUrl === undefined)('a stream for the owner only, in any id case', () => {
  let ollama: StandIn;
  let broker: Awaited<ReturnType<typeof ollamaBroker>>;
  let w: ConversationWorld;
  let conversationId: string;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    ollama = await standInOllama();
    broker = await ollamaBroker(ollama.origin, 'none');
    const fixture = await createApiFixture('stream_owner_only');
    w = await conversationWorld({ fixture, api: composedWith(fixture, broker.exchange) });
    ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS) });
    conversationId = await started(w, w.owner, { body: 'Hello?' });
  }, 180_000);

  afterAll(async () => {
    await broker?.stop();
    await ollama?.close();
    await w?.drop();
    vi.unstubAllEnvs();
  });

  const replies = async (): Promise<number> =>
    await w.count(
      `select count(*)::text as n from public.conversation_messages
        where conversation_id = $1 and role = 'agent'`,
      [conversationId],
    );

  it.each([
    ['lower case', (id: string) => id],
    ['upper case', (id: string) => id.toUpperCase()],
  ])(
    'another person, the id in %s: refused in JSON, no stream, Ollama not asked',
    async (_case, spell) => {
      const before = ollama.seen.length;
      const kept = await replies();
      const refused = await sendStreaming(w.api, w.colleague, 'conversation.message', {
        conversationId: spell(conversationId),
        body: 'Let me read this.',
      });
      expect(refused.contentType).toContain('application/json');
      const body = JSON.parse(await refused.text()) as Record<string, unknown>;
      expect(body).toMatchObject({ refused: true });
      expect(JSON.stringify(body)).not.toContain('tasks');
      expect(ollama.seen.length).toBe(before);
      expect(await replies()).toBe(kept);
    },
  );

  it('a path naming another business: refused in JSON, no stream', async () => {
    const before = ollama.seen.length;
    const response = await w.api.fetch(
      new Request(`http://api.test/api/b/not-this-business/conversation/message`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...authorised(await tokenFor(w.owner.presented.subject)),
        },
        body: JSON.stringify({ operationId: randomUUID(), conversationId, body: 'Hi' }),
      }),
    );
    expect(response.headers.get('content-type') ?? '').not.toContain('text/event-stream');
    expect(response.status).not.toBe(200);
    expect(ollama.seen.length).toBe(before);
  });

  it('the owner in upper case streams, and a lower-case repeat while it answers waits for it', async () => {
    ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS), holdAfter: 2 });
    const before = ollama.seen.length;
    const kept = await replies();
    const operationId = randomUUID();
    const first = await sendStreaming(w.api, w.owner, 'conversation.message', {
      operationId,
      conversationId: conversationId.toUpperCase(),
      body: 'What is due today?',
    });
    expect(first.contentType).toContain('text/event-stream');
    await ollama.midway();
    expect((await first.next())?.event).toBe('piece');
    const repeat = post(
      w.api,
      personPath('conversation.message'),
      { operationId, conversationId, body: 'What is due today?' },
      authorised(await tokenFor(w.owner.presented.subject)),
    );
    ollama.resume();
    const events = await first.rest();
    const again = await repeat;
    expect(outcomeOf(events)).toMatchObject({ reply: { answered: true, body: ANSWER } });
    // A repeat is either the same message read back or refused; never a second answer.
    if (again.status === 200) {
      expect(detail(again)['conversationId']).toBe(conversationId.toUpperCase());
      expect(again.body).toMatchObject({ reply: { answered: true, body: ANSWER } });
    }
    expect(ollama.seen.length - before).toBe(1);
    expect(await replies()).toBe(kept + 1);
  }, 60_000);
});
