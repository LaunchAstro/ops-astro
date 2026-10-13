// SPDX-License-Identifier: AGPL-3.0-only
//
// The streamed answer through the mounted API, on the fixture's
// one-connection pool (the pool the command, each judgement of the pieces,
// the settle and the keep all share):
//
// - a grant row held for update elsewhere while Ollama writes: each
//   judgement's `nowait` hold refuses (55P03), so no piece is handed on, the
//   request never throws and never waits on the holder, and the outcome is the
//   stream's last event;
// - the same operation id sent again, as a stream and as JSON, while the
//   first is still being written: Ollama is asked once, the repeats get no
//   piece, and every outcome carries the one reply kept;
// - a client linked to the page task between two batches: the link is no
//   refusal of the reply (the question asked was an internal task's), so the
//   pieces go on under the same authority the reply is kept under.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addClient, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { holdRow, type Held } from '../support/lock-wait-race.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { createApiFixture, post, authorised, tokenFor } from './fixture.ts';
import { personPath } from './controls-fixture.ts';
import {
  ollamaBroker,
  standInOllama,
  streamedLines,
  type StandIn,
} from './ollama-stand-in-fixture.ts';
import { sendStreaming, type StreamEvent } from './streamed-reply-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const WORDS = ['Two ', 'tasks ', 'are ', 'due.'] as const;

const piecesOf = (events: readonly StreamEvent[]): string =>
  events
    .filter((event) => event.event === 'piece')
    .map((event) => event.data)
    .join('');

const outcomeOf = (events: readonly StreamEvent[]): Record<string, unknown> => {
  const last = events.at(-1);
  expect(last?.event).toBe('outcome');
  expect(events.filter((event) => event.event === 'outcome')).toHaveLength(1);
  return JSON.parse(last?.data ?? '{}') as Record<string, unknown>;
};

// oxlint-disable-next-line max-lines-per-function -- one stand-in, one broker, three schedules
describe.skipIf(serverUrl === undefined)('a streamed answer on the one-connection pool', () => {
  let ollama: StandIn;
  let broker: Awaited<ReturnType<typeof ollamaBroker>>;
  let w: ConversationWorld;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    ollama = await standInOllama();
    broker = await ollamaBroker(ollama.origin, 'none');
    const fixture = await createApiFixture('stream_held_grant');
    w = await conversationWorld({ fixture, api: composedWith(fixture, broker.exchange) });
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await grantTo(tx, w.owner, 'share');
    });
  }, 180_000);

  afterAll(async () => {
    await broker?.stop();
    await ollama?.close();
    await w?.drop();
    vi.unstubAllEnvs();
  });

  const replies = async (conversationId: string): Promise<number> =>
    await w.count(
      `select count(*)::text as n from public.conversation_messages
        where conversation_id = $1 and role = 'agent'`,
      [conversationId],
    );

  it('a grant held for update elsewhere: no piece, no throw, no wait, the outcome last', async () => {
    const [grant] = await w.fixture.db.admin.execute<{ id: string }>(
      `select id from public.grants where subject_id = $1 and collection = 'conversation'
          and action = 'write' and revoked_at is null`,
      [w.owner.personId],
    );
    expect(grant).toBeDefined();
    ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS) });
    const before = ollama.seen.length;
    let holder: Held | undefined;
    ollama.shut();
    try {
      const sending = sendStreaming(w.api, w.owner, 'conversation.start', { body: 'What is due?' });
      await ollama.arrived(before + 1);
      holder = await holdRow(
        w.fixture.db,
        'select id from public.grants where id = $1 for update',
        [grant?.id],
      );
      ollama.open();
      const response = await sending;
      expect(response.contentType ?? '').toContain('text/event-stream');
      // The whole stream ends while the grant row is still held: nothing waited on it.
      const events = await response.rest();
      expect(piecesOf(events)).toBe('');
      const outcome = outcomeOf(events);
      expect(outcome['reply']).toBeUndefined();
      const conversationId = String(
        (outcome['detail'] as Record<string, unknown> | undefined)?.['conversationId'],
      );
      await holder.letGo();
      expect(await replies(conversationId)).toBe(0);
      expect(ollama.seen).toHaveLength(before + 1);
    } finally {
      ollama.open();
      await holder?.letGo();
    }
  }, 60_000);

  it('the same operation id again while the first is written: one ask, no stolen piece, one reply', async () => {
    ollama.reply = (model) => ({
      status: 200,
      chunks: streamedLines(model, WORDS),
      holdAfter: 2,
    });
    const before = ollama.seen.length;
    const operationId = randomUUID();
    const body = { operationId, body: 'What is due this week?' };
    const first = await sendStreaming(w.api, w.owner, 'conversation.start', body);
    await ollama.midway();
    const firstPiece = await first.next();
    expect(firstPiece?.event).toBe('piece');
    const again = sendStreaming(w.api, w.owner, 'conversation.start', body);
    const json = post(
      w.api,
      personPath('conversation.start'),
      body,
      authorised(await tokenFor(w.owner.presented.subject)),
    );
    // Both repeats are in and waiting on the first answer before Ollama goes on.
    const repeat = await again;
    ollama.resume();
    const firstRest = [firstPiece as StreamEvent, ...(await first.rest())];
    const repeatEvents = await repeat.rest();
    const jsonAnswer = await json;
    expect(ollama.seen).toHaveLength(before + 1);
    expect(piecesOf(firstRest)).toBe(WORDS.join(''));
    expect(piecesOf(repeatEvents)).toBe('');
    const kept = outcomeOf(firstRest)['reply'];
    expect(kept).toMatchObject({ answered: true, body: WORDS.join('') });
    expect(outcomeOf(repeatEvents)['reply']).toMatchObject({
      answered: true,
      body: WORDS.join(''),
    });
    expect(jsonAnswer.status).toBe(200);
    expect((jsonAnswer.body as Record<string, unknown>)['reply']).toMatchObject({
      answered: true,
      body: WORDS.join(''),
    });
    const conversationId = String(detail(jsonAnswer)['conversationId']);
    expect(await replies(conversationId)).toBe(1);
  }, 60_000);

  it('a client linked between two batches: the pieces go on, as the reply is kept', async () => {
    const made = await w.as(w.owner, 'task.create', { fields: { title: 'Internal for now' } });
    const taskId = String(made.body['recordId']);
    const clientId = randomUUID();
    await addClient(w.fixture.db.app, w.fixture.business, clientId, w.owner);
    ollama.reply = (model) => ({
      status: 200,
      chunks: streamedLines(model, WORDS),
      holdAfter: 2,
    });
    const response = await sendStreaming(w.api, w.owner, 'conversation.start', {
      body: 'What is this?',
      scope: { kind: 'task', id: taskId },
    });
    await ollama.midway();
    const firstPiece = await response.next();
    expect(firstPiece?.event).toBe('piece');
    const link = await w.as(w.owner, 'task.set_party', {
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: made.body['revision'],
      fields: { client: clientId },
    });
    expect(link.status).toBe(200);
    ollama.resume();
    const events = [firstPiece as StreamEvent, ...(await response.rest())];
    const outcome = outcomeOf(events);
    expect(outcome['reply']).toMatchObject({ answered: true, body: WORDS.join('') });
    expect(piecesOf(events)).toBe(WORDS.join(''));
  }, 60_000);
});
