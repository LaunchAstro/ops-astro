// SPDX-License-Identifier: AGPL-3.0-only
//
// A browser that sends the same message again (the same operation id), as a
// stream or as JSON, while the first is still being answered, after it was
// kept, and after the call was held. While it answers, the repeat waits for
// the one answer: Ollama is asked once, one reply is kept, and the repeat gets
// no pieces of its own. Once kept, a repeat reads the kept reply and asks
// nothing. Once held, the message keeps its one call: a repeat asks nothing
// and is told the answer ended, so the person sends the message again, a new
// message. Another person who sends the owner's operation id gets no reply and
// no piece. A server lost between Ollama's answer and the settle keeps
// nothing; while the call is still started a repeat is told it is still
// answering, and once the sweep holds it, that the answer ended.

import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { composeApi } from '../../apps/api/server.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { sweepModelCalls } from '../../packages/core-custody/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { holdRow } from '../support/lock-wait-race.ts';
import { waitingOn } from '../support/lock-waits.ts';
import { testSignIn } from '../support/sign-in.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { authorised, createApiFixture, ISSUER, post, tokenFor } from './fixture.ts';
import { personPath } from './controls-fixture.ts';
import type { Member } from '../commands/fixture.ts';
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

const piecesOf = (events: readonly StreamEvent[]): readonly StreamEvent[] =>
  events.filter((event) => event.event === 'piece');

const outcomeOf = (events: readonly StreamEvent[]): Record<string, unknown> => {
  const last = events.at(-1);
  expect(last?.event).toBe('outcome');
  return JSON.parse(last?.data ?? '{}') as Record<string, unknown>;
};

// oxlint-disable-next-line max-lines-per-function -- one stand-in, one broker and one world
/** `conversation.start` as `member`, through `api`. */
const send = async (api: Hono, member: Member, body: Record<string, unknown> = {}) =>
  await post(
    api,
    personPath('conversation.start'),
    body,
    authorised(await tokenFor(member.presented.subject)),
  );

// oxlint-disable-next-line max-lines-per-function -- one stand-in, one broker and one world
describe.skipIf(serverUrl === undefined)('the same message sent again', () => {
  let ollama: StandIn;
  let broker: Awaited<ReturnType<typeof ollamaBroker>>;
  let w: ConversationWorld;
  let pool: Database;
  let lost: Hono;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    ollama = await standInOllama();
    broker = await ollamaBroker(ollama.origin, 'none');
    const fixture = await createApiFixture('same_message_sent_again');
    w = await conversationWorld({ fixture, api: composedWith(fixture, broker.exchange) });
    // A server of its own pool, so its connection can be lost without the world's.
    pool = connect(fixture.db.appUrl);
    lost = composeApi({
      keys: runtimeKeys({ ...fixture.environment }),
      database: pool,
      admin: fixture.db.admin,
      signIn: testSignIn(ISSUER),
      executeRead,
      answerConversation: broker.exchange,
    }).app;
  }, 180_000);

  afterAll(async () => {
    await broker?.stop();
    await pool?.close();
    await ollama?.close();
    await w?.drop();
    vi.unstubAllEnvs();
  });

  const calls = async (conversationId: string) =>
    await w.fixture.db.admin.execute<Record<string, unknown>>(
      `select state from public.model_calls where conversation_id = $1 order by started_at`,
      [conversationId],
    );

  const replies = async (conversationId: string): Promise<readonly unknown[]> =>
    (
      await w.fixture.db.admin.execute<{ body: string }>(
        `select body from public.conversation_messages
          where conversation_id = $1 and role = 'agent'`,
        [conversationId],
      )
    ).map((row) => row.body);

  const dispatched = async (): Promise<string> => {
    const rows = await w.fixture.db.admin.execute<{ id: string }>(
      `select id::text from public.model_calls where state = 'dispatched'`,
    );
    expect(rows).toHaveLength(1);
    return String(rows[0]?.id);
  };

  it('a JSON repeat while the stream answers waits for the one answer; a stream repeat after reads it', async () => {
    ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS), holdAfter: 2 });
    const before = ollama.seen.length;
    const operationId = randomUUID();
    const body = { operationId, body: 'What is due today?' };
    const first = await sendStreaming(w.api, w.owner, 'conversation.start', body);
    await ollama.midway();
    expect((await first.next())?.event).toBe('piece');
    const repeat = send(w.api, w.owner, body);
    // The repeat has kept nothing new and is waiting: still one request at Ollama.
    expect(ollama.seen.length - before).toBe(1);
    ollama.resume();
    const events = await first.rest();
    const again = await repeat;
    expect(outcomeOf(events)).toMatchObject({ reply: { answered: true, body: ANSWER } });
    expect(again.body).toMatchObject({ reply: { answered: true, body: ANSWER } });
    const conversationId = String(detail(again)['conversationId']);
    expect(await calls(conversationId)).toEqual([{ state: 'settled' }]);
    expect(await replies(conversationId)).toEqual([ANSWER]);
    // Kept: a stream repeat reads the reply, with no piece, and asks nothing.
    const late = await (await sendStreaming(w.api, w.owner, 'conversation.start', body)).rest();
    expect(piecesOf(late)).toEqual([]);
    expect(outcomeOf(late)).toMatchObject({ reply: { answered: true, body: ANSWER } });
    expect(ollama.seen.length - before).toBe(1);
  }, 60_000);

  it('a stream repeat while JSON answers gets no pieces of its own and the one reply', async () => {
    ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS), holdAfter: 2 });
    const before = ollama.seen.length;
    const body = { operationId: randomUUID(), body: 'And tomorrow?' };
    const first = send(w.api, w.owner, body);
    await ollama.midway();
    const repeat = await sendStreaming(w.api, w.owner, 'conversation.start', body);
    ollama.resume();
    const events = await repeat.rest();
    const answered = await first;
    expect(answered.body).toMatchObject({ reply: { answered: true, body: ANSWER } });
    // The first request's pieces are its own: the repeat only waited.
    expect(piecesOf(events)).toEqual([]);
    expect(outcomeOf(events)).toMatchObject({ reply: { answered: true, body: ANSWER } });
    const conversationId = String(detail(answered)['conversationId']);
    expect(await calls(conversationId)).toEqual([{ state: 'settled' }]);
    expect(await replies(conversationId)).toHaveLength(1);
    expect(ollama.seen.length - before).toBe(1);
  }, 60_000);

  it('another person who sends the owner’s operation id gets no reply and no piece', async () => {
    ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS), holdAfter: 2 });
    const before = ollama.seen.length;
    const body = { operationId: randomUUID(), body: 'My own question.' };
    const first = await sendStreaming(w.api, w.owner, 'conversation.start', body);
    await ollama.midway();
    const other = await sendStreaming(w.api, w.colleague, 'conversation.start', body);
    const otherEvents = other.contentType?.startsWith('text/event-stream')
      ? await other.rest()
      : [];
    const otherText = JSON.stringify(otherEvents) + (await other.text().catch(() => ''));
    ollama.resume();
    const events = await first.rest();
    expect(outcomeOf(events)).toMatchObject({ reply: { answered: true, body: ANSWER } });
    expect(piecesOf(otherEvents)).toEqual([]);
    expect(otherText).not.toContain('tasks');
    expect(ollama.seen.length - before).toBe(1);
  }, 60_000);

  it('held: a repeat asks again for nothing; it is told the answer ended', async () => {
    ollama.shut();
    ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS) });
    const before = ollama.seen.length;
    const body = { operationId: randomUUID(), body: 'Is anything late?' };
    const first = await sendStreaming(w.api, w.owner, 'conversation.start', body);
    await ollama.arrived(before + 1);
    const callId = await dispatched();
    await w.fixture.db.admin.execute(
      `update public.model_calls set started_at = started_at - interval '11 minutes',
              accepted_at = accepted_at - interval '11 minutes' where id = $1`,
      [callId],
    );
    await w.fixture.db.app.withBusiness(
      w.fixture.business,
      async (tx) => await sweepModelCalls(tx),
    );
    ollama.open();
    expect(outcomeOf(await first.rest())).toMatchObject({
      reply: { answered: false, code: 'DECISION_STALE' },
    });
    const again = await send(w.api, w.owner, body);
    expect(again.body).toMatchObject({ reply: { answered: false, code: 'ANSWER_ENDED' } });
    const conversationId = String(detail(again)['conversationId']);
    expect(await calls(conversationId)).toEqual([{ state: 'liability_unknown' }]);
    expect(await replies(conversationId)).toEqual([]);
    expect(ollama.seen.length - before).toBe(1);
  }, 60_000);

  // oxlint-disable-next-line max-lines-per-function -- one lost settle followed to the sweep
  it('a server lost between the answer and the settle keeps nothing; a repeat is told it is still answering, then that it ended', async () => {
    ollama.shut();
    ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS) });
    const before = ollama.seen.length;
    const body = { operationId: randomUUID(), body: 'What did I miss?' };
    const first = await sendStreaming(lost, w.owner, 'conversation.start', body);
    await ollama.arrived(before + 1);
    const callId = await dispatched();
    const holder = await holdRow(
      w.fixture.db,
      'select id from public.model_calls where id = $1 for update',
      [callId],
    );
    ollama.open();
    await waitingOn(w.fixture.db.admin, 'transactionid', 'select state from public.model_calls');
    // The server goes: its settle is cut off while it waits, and rolls back.
    await w.fixture.db.admin.execute(
      `select pg_cancel_backend(pid) from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and strpos(query, 'select state from public.model_calls') > 0`,
    );
    await holder.letGo();
    const events = await first.rest();
    expect(events.some((event) => event.event === 'outcome')).toBe(false);
    const [row] = await w.fixture.db.admin.execute<{ conversation_id: string; state: string }>(
      `select conversation_id::text, state from public.model_calls where id = $1`,
      [callId],
    );
    const conversationId = String(row?.conversation_id);
    expect(row?.state).toBe('dispatched');
    expect(await replies(conversationId)).toEqual([]);
    expect(ollama.seen.length - before).toBe(1);
    // Restarted, the same message: its one call is still started.
    const busy = await send(w.api, w.owner, body);
    expect(busy.body).toMatchObject({ reply: { answered: false, code: 'STILL_ANSWERING' } });
    expect(ollama.seen.length - before).toBe(1);
    // The sweep holds it at its ten minutes; then the repeat asks nothing and is told it ended.
    await w.fixture.db.admin.execute(
      `update public.model_calls set started_at = started_at - interval '11 minutes',
              accepted_at = accepted_at - interval '11 minutes' where id = $1`,
      [callId],
    );
    await w.fixture.db.app.withBusiness(
      w.fixture.business,
      async (tx) => await sweepModelCalls(tx),
    );
    const again = await send(w.api, w.owner, body);
    expect(again.body).toMatchObject({ reply: { answered: false, code: 'ANSWER_ENDED' } });
    expect(await calls(conversationId)).toEqual([{ state: 'liability_unknown' }]);
    expect(await replies(conversationId)).toEqual([]);
    expect(ollama.seen.length - before).toBe(1);
  }, 60_000);
});
