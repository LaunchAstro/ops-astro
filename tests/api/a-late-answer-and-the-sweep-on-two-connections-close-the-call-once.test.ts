// SPDX-License-Identifier: AGPL-3.0-only
//
// The settle of a side panel answer and the sweep, each on its own
// connection, queued on the same call row in an order the database reports,
// never a sleep. A holder takes the row first; the two racers queue behind it
// (the first on the holder's transaction, the second on the row's tuple lock),
// so the first queued closes the call. Sweep first: the call stays held, the
// answer keeps no reply and the stream's outcome says it did not finish.
// Settle first: the reply is kept once and the sweep holds nothing. A call
// short of its ten minutes is never held by the sweep.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { sweepModelCalls } from '../../packages/core-custody/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { holdRow } from '../support/lock-wait-race.ts';
import { waitingOn } from '../support/lock-waits.ts';
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

const WORDS = ['Two ', 'tasks ', 'are ', 'due ', 'today.'];
const SETTLE = 'select state from public.model_calls';
const SWEEP = 'conversation_id is not null';

const outcomeOf = (events: readonly StreamEvent[]): Record<string, unknown> => {
  const last = events.at(-1);
  expect(last?.event).toBe('outcome');
  return JSON.parse(last?.data ?? '{}') as Record<string, unknown>;
};

// oxlint-disable-next-line max-lines-per-function -- one stand-in, one broker and one world
describe.skipIf(serverUrl === undefined)('a late answer and the sweep on two connections', () => {
  let ollama: StandIn;
  let broker: Awaited<ReturnType<typeof ollamaBroker>>;
  let w: ConversationWorld;
  let sweeper: Database;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    ollama = await standInOllama();
    broker = await ollamaBroker(ollama.origin, 'none');
    const fixture = await createApiFixture('late_answer_two_connections');
    w = await conversationWorld({ fixture, api: composedWith(fixture, broker.exchange) });
    sweeper = connect(fixture.db.appUrl);
  }, 180_000);

  afterAll(async () => {
    await sweeper?.close();
    await broker?.stop();
    await ollama?.close();
    await w?.drop();
    vi.unstubAllEnvs();
  });

  const sweep = async () =>
    await sweeper.withBusiness(w.fixture.business, async (tx) => await sweepModelCalls(tx));

  /** The call the stand-in is holding: its id and conversation. */
  async function inFlight(): Promise<{ readonly id: string; readonly conversationId: string }> {
    const rows = await w.fixture.db.admin.execute<{ id: string; conversation_id: string }>(
      `select id::text, conversation_id::text from public.model_calls where state = 'dispatched'`,
    );
    expect(rows).toHaveLength(1);
    return { id: String(rows[0]?.id), conversationId: String(rows[0]?.conversation_id) };
  }

  const aged = async (callId: string, by: string): Promise<void> => {
    await w.fixture.db.admin.execute(
      `update public.model_calls
          set accepted_at = accepted_at - $2::interval, started_at = started_at - $2::interval
        where id = $1`,
      [callId, by],
    );
  };

  const row = async (callId: string) =>
    (
      await w.fixture.db.admin.execute<Record<string, unknown>>(
        `select state, actual_minor::int as actual_minor, drop_state from public.model_calls
          where id = $1`,
        [callId],
      )
    )[0];

  const replies = async (conversationId: string): Promise<number> =>
    await w.count(
      `select count(*)::text as n from public.conversation_messages
        where conversation_id = $1 and role = 'agent'`,
      [conversationId],
    );

  /** Every settle the audit chain holds, in this database. */
  const settledEvents = async (): Promise<number> =>
    await w.count(
      `select count(*)::text as n from public.audit_events where command = 'model.call_dispatched'`,
      [],
    );

  /** A message on its way to a shut stand-in, and the call it made. */
  async function asking(body: string) {
    ollama.shut();
    ollama.reply = (model) => ({ status: 200, chunks: streamedLines(model, WORDS) });
    const before = ollama.seen.length;
    const sending = sendStreaming(w.api, w.owner, 'conversation.start', { body });
    await ollama.arrived(before + 1);
    return { sending, call: await inFlight(), before, settles: await settledEvents() };
  }

  it('sweep queued first: held, no reply, the outcome says it did not finish', async () => {
    const { sending, call, before, settles } = await asking('What is due today?');
    await aged(call.id, '11 minutes');
    const holder = await holdRow(
      w.fixture.db,
      'select id from public.model_calls where id = $1 for update',
      [call.id],
    );
    const swept = sweep();
    await waitingOn(w.fixture.db.admin, 'transactionid', SWEEP);
    ollama.open();
    await waitingOn(w.fixture.db.admin, 'tuple', SETTLE);
    await holder.letGo();
    expect((await swept).held).toBe(1);
    const events = await (await sending).rest();
    expect(outcomeOf(events)).toMatchObject({
      reply: { answered: false, code: 'DECISION_STALE' },
    });
    expect(await row(call.id)).toEqual({
      state: 'liability_unknown',
      actual_minor: null,
      drop_state: 'dropped_no_answer',
    });
    expect(await replies(call.conversationId)).toBe(0);
    expect(await settledEvents()).toBe(settles);
    expect(ollama.seen.length - before).toBe(1);
  }, 60_000);

  it('settle queued first: the reply is kept once and the sweep holds nothing', async () => {
    const { sending, call, before, settles } = await asking('What is due this week?');
    await aged(call.id, '11 minutes');
    const holder = await holdRow(
      w.fixture.db,
      'select id from public.model_calls where id = $1 for update',
      [call.id],
    );
    ollama.open();
    await waitingOn(w.fixture.db.admin, 'transactionid', SETTLE);
    const swept = sweep();
    await waitingOn(w.fixture.db.admin, 'tuple', SWEEP);
    await holder.letGo();
    expect((await swept).held).toBe(0);
    const events = await (await sending).rest();
    expect(outcomeOf(events)).toMatchObject({
      reply: { answered: true, body: 'Two tasks are due today.' },
    });
    expect(await row(call.id)).toEqual({ state: 'settled', actual_minor: 0, drop_state: null });
    expect(await replies(call.conversationId)).toBe(1);
    expect(await settledEvents()).toBe(settles + 1);
    expect(ollama.seen.length - before).toBe(1);
  }, 60_000);

  it('a call short of its ten minutes is not held, and its answer is kept', async () => {
    const { sending, call } = await asking('Anything overdue?');
    await aged(call.id, '9 minutes 50 seconds');
    expect((await sweep()).held).toBe(0);
    ollama.open();
    const events = await (await sending).rest();
    expect(outcomeOf(events)).toMatchObject({ reply: { answered: true } });
    expect(await row(call.id)).toMatchObject({ state: 'settled' });
    expect(await replies(call.conversationId)).toBe(1);
  }, 60_000);
});
