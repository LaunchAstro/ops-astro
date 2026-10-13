// SPDX-License-Identifier: AGPL-3.0-only
//
// One paid message, one call, one hold, one charge, however often and from
// however many instances it is sent, on schedules ordered by what Postgres
// reports waiting:
//
//   at once      two instances of the function, each on its own pool and
//                custody, wait on the chat budget's row lock together for
//                the same message, the second naming it in capitals: one
//                call, OpenRouter asked once, one hold settled at its cost;
//                the twin is told the answer is on its way.
//   answered     the same message sent again on the other instance after its
//                reply was kept, by operation id and by its ids in capitals:
//                the kept reply, no call, nothing sent.
//   released     sent again after its call was released (the agent refused
//                before sending): told it ended, no new call, nothing held.
//   held         sent again after its call was held at the most (the agent
//                took the request and went quiet): told it ended, nothing
//                sent a second time, the hold counted once.

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationReply } from '../../packages/core-commands/src/index.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { holdApp, waitersOf } from './carried-exchange-fixture.ts';
import { carriedWorld, PAID_HOLD, type CarriedTwin, type CarriedWorld } from './carried-world.ts';
import { callFor, heldFor, repliesTo } from './carried-schedules.ts';
import { tokenFor } from './fixture.ts';
import { HAIKU } from './openrouter-stand-in-fixture.ts';
import { sendStreaming, type StreamEvent } from './streamed-reply-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const outcome = (events: readonly StreamEvent[]) =>
  JSON.parse(events.at(-1)?.data ?? '{}') as { readonly reply?: Record<string, unknown> };

// oxlint-disable-next-line max-lines-per-function -- one carried world and its twin per case
describe.skipIf(serverUrl === undefined)('a carried paid message sent twice', () => {
  let world: CarriedWorld;
  let twin: CarriedTwin;

  beforeEach(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    world = await carriedWorld('carried_paid_twice', undefined, {}, true);
    twin = await world.twin();
  }, 180_000);

  afterEach(async () => {
    world?.openrouter?.open();
    await twin?.close();
    await world?.close();
    vi.unstubAllEnvs();
  });

  /** `conversation.start` on `api` with this operation id, on the paid model: the same message each time. */
  const start = (api: CarriedWorld['api'], operationId: string, body: string) =>
    sendStreaming(api, world.w.owner, 'conversation.start', { operationId, body, model: HAIKU });

  /** The ids of the one message asked with `body`. */
  async function idsOf(body: string): Promise<{ conversationId: string; messageId: string }> {
    const [row] = await world.w.fixture.db.admin.execute<{
      readonly conversationId: string;
      readonly messageId: string;
    }>(
      `select conversation_id::text as "conversationId", id::text as "messageId"
         from public.conversation_messages where body = $1 and role = 'person'`,
      [body],
    );
    if (row === undefined) throw new Error('the message was not kept');
    return row;
  }

  /** The twin's exchange asked for the message directly, its ids in capitals. */
  const twinAsks = async (body: string): Promise<ConversationReply | null> => {
    const { conversationId, messageId } = await idsOf(body);
    return await twin.exchange(
      twin.database,
      world.w.fixture.business as BusinessId,
      world.w.owner.presented,
      { conversationId: conversationId.toUpperCase(), messageId: messageId.toUpperCase() },
      undefined,
      await tokenFor(world.w.owner.presented.subject),
    );
  };

  /** Waits until `n` backends wait to lock the chat budget's row (the second queues behind the first). */
  async function capWaiters(n: number): Promise<void> {
    for (let tries = 0; tries < 500; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polls the server
      const waiting = await world.w.count(
        `select count(*)::text as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and query like '%from public.budget_caps%for update%'
            and cardinality(pg_blocking_pids(pid)) > 0`,
        [],
      );
      if (waiting >= n) return;
      // oxlint-disable-next-line no-await-in-loop -- polls the server
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    throw new Error(`${String(n)} holds never waited on the chat budget's row`);
  }

  const calls = async (body: string): Promise<number> =>
    await world.w.count(
      `select count(*)::text as n from public.model_calls c
         join public.conversation_messages m on m.id = c.conversation_message_id
        where m.body = $1`,
      [body],
    );

  it('at once on two instances: one call, one request, one hold settled at its cost', async () => {
    const body = 'Due, paid? (two instances at once)';
    const { fixture } = world.w;
    await fixture.db.admin.execute(
      `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
       values ($1, $2, 'planning', 5000, 'AUD') on conflict (business_id, key) do nothing`,
      [fixture.business, randomUUID()],
    );
    const cap = await holdApp(fixture.db.appUrl, fixture.business, async (tx) => {
      await tx.query(
        `select 1 from public.budget_caps where business_id = $1 and key = 'planning' for update`,
        [tx.businessId],
      );
    });
    world.openrouter?.shut();
    const first = start(world.api, randomUUID(), body);
    await waitersOf(fixture.db.admin, cap.pid, 1);
    const second = twinAsks(body);
    try {
      await capWaiters(2);
    } finally {
      await cap.letGo();
    }
    await world.openrouter?.arrived(1);
    expect(await calls(body)).toBe(1);
    world.openrouter?.open();
    const [events, twinReply] = await Promise.all([(await first).rest(), second]);
    const replies = [outcome(events).reply, twinReply];
    expect(replies.filter((one) => one?.['answered'] === true)).toHaveLength(1);
    expect(replies.find((one) => one?.['answered'] !== true)).toMatchObject({
      answered: false,
      code: 'STILL_ANSWERING',
    });
    expect(world.openrouter?.received).toHaveLength(1);
    expect(await calls(body)).toBe(1);
    const [call] = await callFor(world, body);
    expect(call).toMatchObject({ state: 'settled' });
    expect(await heldFor(world, body)).toEqual([{ reserved: PAID_HOLD, committed: call?.actual }]);
    expect(await repliesTo(world, body)).toBe(1);
  }, 60_000);

  it('sent again after its reply was kept: the kept reply, no call, nothing sent', async () => {
    const body = 'Due, paid? (again once answered)';
    const operationId = randomUUID();
    const once = outcome(await (await start(world.api, operationId, body)).rest());
    expect(once.reply).toMatchObject({ answered: true });
    const again = outcome(await (await start(twin.api, operationId, body)).rest());
    expect(again.reply).toMatchObject({ answered: true, body: once.reply?.['body'] });
    expect(await twinAsks(body)).toMatchObject({ answered: true, body: once.reply?.['body'] });
    expect(world.openrouter?.received).toHaveLength(1);
    expect(await calls(body)).toBe(1);
    expect(await repliesTo(world, body)).toBe(1);
  }, 60_000);

  it('sent again after its call was released: told it ended, no call, nothing held', async () => {
    const body = 'Due, paid? (again once released)';
    const operationId = randomUUID();
    world.agent.mode = 'refuse';
    const once = outcome(await (await start(world.api, operationId, body)).rest());
    expect(once.reply).toMatchObject({ answered: false });
    world.agent.mode = 'run';
    const again = outcome(await (await start(twin.api, operationId, body)).rest());
    expect(again.reply).toMatchObject({ answered: false, code: 'ANSWER_ENDED' });
    expect(await twinAsks(body)).toMatchObject({ answered: false, code: 'ANSWER_ENDED' });
    expect(world.openrouter?.received).toHaveLength(0);
    expect(await calls(body)).toBe(1);
    expect(await heldFor(world, body)).toEqual([{ reserved: PAID_HOLD, committed: 0 }]);
  }, 60_000);

  it('sent again after its call was held at the most: nothing sent twice, the hold counted once', async () => {
    const body = 'Due, paid? (again once held)';
    const operationId = randomUUID();
    world.agent.mode = 'unreported';
    const once = outcome(await (await start(world.api, operationId, body)).rest());
    expect(once.reply).toMatchObject({ answered: false });
    expect(await callFor(world, body)).toMatchObject([{ state: 'liability_unknown' }]);
    world.agent.mode = 'run';
    const again = outcome(await (await start(twin.api, operationId, body)).rest());
    expect(again.reply).toMatchObject({ answered: false, code: 'ANSWER_ENDED' });
    expect(await twinAsks(body)).toMatchObject({ answered: false, code: 'ANSWER_ENDED' });
    world.agent.release();
    expect(world.openrouter?.received).toHaveLength(1);
    expect(await calls(body)).toBe(1);
    expect(await heldFor(world, body)).toEqual([{ reserved: PAID_HOLD, committed: PAID_HOLD }]);
    expect(await repliesTo(world, body)).toBe(0);
  }, 60_000);
});
