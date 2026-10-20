// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one stand-in, two instances and one schedule per way a twin ends */
//
// One message, one model call, when two API instances (each its own exchange
// and custody) hand the exchange the same message at the same instant. The
// schedules are set by what `pg_stat_activity` reports, never by sleeps:
//
//   at once      both instances wait on the seam's limit lock together, then
//                go on: one call row, Ollama asked once, the other told the
//                answer is on its way (never that the model is busy with its
//                own message's call); the call's start is read after the wait.
//   crash        a twin's insert of the message's call is rolled back while it
//                holds the limit lock: the waiting instance makes the one call,
//                and a retry on the other asks nothing.
//   lost         a call committed and never sent (its process lost): the retry
//                is told the answer is on its way, nothing sent, and after the
//                sweep, that the answer ended.
//   settling     the call has settled and its reply waits on the conversation
//                row: the same message on the other instance must not be told
//                the answer ended (send it again) while the reply is being kept.
//   upper case   the same message named in capitals is the same message.
//   scope        another business's call on its own message is not this one's.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { CONVERSATION_ANSWER } from '../../packages/core-connectors/src/index.ts';
import { sweepModelCalls } from '../../packages/core-custody/src/index.ts';
import type { ConversationReply } from '../../packages/core-commands/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold } from '../support/lock-wait-race.ts';
import { waitingOn } from '../support/lock-waits.ts';
import { conversationWorld, detail, type ConversationWorld } from './aw-03-fixture.ts';
import { composedWith } from './aw-03-exchange-fixture.ts';
import { createApiFixture } from './fixture.ts';
import { ollamaBroker, says, standInOllama, type StandIn } from './ollama-stand-in-fixture.ts';
import { carriageBusiness } from './carriage-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const QWEN = 'qwen3.6:35b-mlx';

const within = async <T>(ms: number, work: Promise<T>): Promise<T> =>
  await Promise.race([
    work,
    sleep(ms).then(() => {
      throw new Error(`still waiting after ${String(ms)} ms`);
    }),
  ]);

type Instance = Awaited<ReturnType<typeof ollamaBroker>>;
interface Asked {
  readonly conversationId: string;
  readonly messageId: string;
}

// eslint-disable-next-line max-lines-per-function -- one stand-in, two instances, one world
describe.skipIf(serverUrl === undefined)('one message sent at once on two instances', () => {
  let ollama: StandIn;
  let first: Instance;
  let second: Instance;
  let w: ConversationWorld;

  beforeAll(async () => {
    vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
    ollama = await standInOllama();
    first = await ollamaBroker(ollama.origin);
    second = await ollamaBroker(ollama.origin);
    const fixture = await createApiFixture('one_message_at_once');
    w = await conversationWorld({
      fixture,
      api: composedWith(fixture, async () => await Promise.resolve(null)),
    });
  }, 180_000);

  afterAll(async () => {
    ollama?.open();
    await first?.stop();
    await second?.stop();
    await ollama?.close();
    await w?.drop();
    vi.unstubAllEnvs();
  });

  async function question(body: string): Promise<Asked> {
    const opened = await w.as(w.owner, 'conversation.start', { body });
    return {
      conversationId: String(detail(opened)['conversationId']),
      messageId: String(detail(opened)['messageId']),
    };
  }

  const limitKey = () => `limit:${w.fixture.business}:model_call:${CONVERSATION_ANSWER.key}`;

  const callsFor = async (conversationId: string) =>
    await w.fixture.db.admin.execute<{ readonly id: string; readonly state: string }>(
      `select id::text, state from public.model_calls where conversation_id = $1 order by started_at`,
      [conversationId],
    );

  /** Waits until `n` backends wait on a lock the backend `pid` holds. */
  async function waitersOf(pid: number, n: number): Promise<void> {
    for (let tries = 0; tries < 500; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polls the server
      const found = await w.count(
        `select count(*)::text as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and $1::int = any(pg_blocking_pids(pid))`,
        [pid],
      );
      if (found >= n) return;
      // oxlint-disable-next-line no-await-in-loop -- polls the server
      await sleep(10);
    }
    throw new Error(`${String(n)} backends never waited on the held lock`);
  }

  // eslint-disable-next-line max-lines-per-function -- one schedule, its checks and its clean-up
  it('at once: one call, Ollama asked once, the other told it is still answering, its start read after the wait', async () => {
    const { db, business } = w.fixture;
    const asked = await question('What is due today?');
    const before = ollama.seen.length;
    const holder = await hold(
      db,
      async (execute) => {
        await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [limitKey()]);
      },
      async (execute) =>
        (await execute<{ at: string }>('select clock_timestamp()::text as at'))[0]?.at ?? '',
    );
    const readers = [0, 1].map(() => connect(db.appUrl, { source: 'runtime' }));
    ollama.shut();
    const asking: Promise<ConversationReply | null>[] = [];
    try {
      asking.push(
        first.exchange(readers[0]!, business, w.owner.presented, asked),
        second.exchange(readers[1]!, business, w.owner.presented, asked),
      );
      await waitersOf(holder.pid, 2);
      const letGoAt = await holder.letGo();
      const [toldAt, told] = await within(
        10_000,
        Promise.race(asking.map(async (one, at) => [at, await one] as const)),
      );
      expect(told, 'the twin was told the model is busy with its own message').toMatchObject({
        answered: false,
        code: 'STILL_ANSWERING',
      });
      await ollama.arrived(before + 1);
      ollama.open();
      expect(await within(10_000, asking[1 - toldAt]!)).toMatchObject({
        answered: true,
        body: says(QWEN),
      });
      expect(ollama.seen).toHaveLength(before + 1);
      const calls = await callsFor(asked.conversationId);
      expect(calls.map((one) => one.state)).toEqual(['settled']);
      // The call's start is read after the limit lock it waited on was let go.
      const [late] = await db.admin.execute<{ readonly after: boolean }>(
        `select started_at >= $2::text::timestamptz as after from public.model_calls where id = $1`,
        [calls[0]?.id, letGoAt],
      );
      expect(late?.after, 'started_at was read before the limit lock wait').toBe(true);
    } finally {
      ollama.open();
      await holder.letGo();
      await Promise.allSettled(asking);
      await Promise.allSettled(readers.map(async (one) => await one.close()));
    }
  }, 60_000);

  it('crash: a twin insert rolled back under the limit lock leaves one call, and a retry asks nothing', async () => {
    const { db, business } = w.fixture;
    const asked = await question('Crashed twin?');
    const before = ollama.seen.length;
    // The twin: the limit lock, then the message's call, as the seam writes it; then it dies.
    const twin = await hold(
      db,
      async (execute) => {
        await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [limitKey()]);
        await execute(
          `insert into public.model_calls
             (business_id, id, conversation_id, conversation_message_id, operation_key, state,
              reserved_minor, route_key, route_reach, credential_kind, provider, credential_ref,
              started_at)
           values ($1, gen_random_uuid(), $2, $3, $4, 'dispatched', 0, 'm5_ollama', 'local',
                   'api_key', 'ollama', 'ollama_key', clock_timestamp())`,
          [business, asked.conversationId, asked.messageId, CONVERSATION_ANSWER.key],
        );
      },
      async () => await Promise.reject(new Error('the twin crashed')),
    );
    const reader = connect(db.appUrl, { source: 'runtime' });
    let asking: Promise<ConversationReply | null> | undefined;
    try {
      asking = first.exchange(reader, business, w.owner.presented, asked);
      await waitersOf(twin.pid, 1);
      await expect(twin.letGo()).rejects.toThrow('the twin crashed');
      expect(await within(10_000, asking)).toMatchObject({ answered: true, body: says(QWEN) });
      expect(
        await within(10_000, second.exchange(db.app, business, w.owner.presented, asked)),
      ).toMatchObject({ answered: true, body: says(QWEN) });
      expect(ollama.seen).toHaveLength(before + 1);
      expect((await callsFor(asked.conversationId)).map((one) => one.state)).toEqual(['settled']);
    } finally {
      await twin.letGo().catch(() => null);
      await asking?.catch(() => null);
      await reader.close();
    }
  }, 60_000);

  it('lost: a call committed and never sent is still answering, then ended by the sweep; nothing is sent', async () => {
    const { db, business } = w.fixture;
    const asked = await question('Lost process?');
    const before = ollama.seen.length;
    await db.admin.execute(
      `insert into public.model_calls
         (business_id, id, conversation_id, conversation_message_id, operation_key, state,
          reserved_minor, route_key, route_reach, credential_kind, provider, credential_ref,
          started_at)
       values ($1, gen_random_uuid(), $2, $3, $4, 'dispatched', 0, 'm5_ollama', 'local',
               'api_key', 'ollama', 'ollama_key', clock_timestamp())`,
      [business, asked.conversationId, asked.messageId, CONVERSATION_ANSWER.key],
    );
    expect(
      await within(10_000, second.exchange(db.app, business, w.owner.presented, asked)),
    ).toMatchObject({ answered: false, code: 'STILL_ANSWERING' });
    await db.admin.execute(
      `update public.model_calls set started_at = started_at - interval '11 minutes',
              accepted_at = accepted_at - interval '11 minutes'
        where conversation_id = $1`,
      [asked.conversationId],
    );
    await db.app.withBusiness(business, async (tx) => await sweepModelCalls(tx));
    expect(
      await within(10_000, first.exchange(db.app, business, w.owner.presented, asked)),
    ).toMatchObject({ answered: false, code: 'ANSWER_ENDED' });
    expect(ollama.seen).toHaveLength(before);
    expect((await callsFor(asked.conversationId)).map((one) => one.state)).toEqual([
      'liability_unknown',
    ]);
  }, 60_000);

  // eslint-disable-next-line max-lines-per-function -- one schedule, its checks and its clean-up
  it('settling: while the settled answer waits to be kept, the same message is not told the answer ended', async () => {
    const { db, business } = w.fixture;
    const asked = await question('Kept in a moment?');
    const before = ollama.seen.length;
    // The conversation row, held as an update of it holds it (no key change, so the call's
    // own key check passes): the reply's keep, which locks it for update, waits on it.
    const row = await hold(db, async (execute) => {
      await execute('select 1 from public.conversations where id = $1 for no key update', [
        asked.conversationId,
      ]);
    });
    const reader = connect(db.appUrl, { source: 'runtime' });
    let asking: Promise<ConversationReply | null> | undefined;
    let again: ConversationReply | null = null;
    try {
      asking = first.exchange(reader, business, w.owner.presented, asked);
      await waitingOn(db.admin, 'transactionid', 'select body_purged_at from conversations');
      expect((await callsFor(asked.conversationId)).map((one) => one.state)).toEqual(['settled']);
      again = await within(10_000, second.exchange(db.app, business, w.owner.presented, asked));
      await row.letGo();
      expect(await within(10_000, asking)).toMatchObject({ answered: true, body: says(QWEN) });
      expect(ollama.seen).toHaveLength(before + 1);
      // The reply is kept: telling the person the answer ended, to send it again, was wrong.
      expect(
        again,
        'ANSWER_ENDED told for a settled call whose reply was being kept (send it again: a second call)',
      ).not.toMatchObject({ code: 'ANSWER_ENDED' });
    } finally {
      await row.letGo();
      await asking?.catch(() => null);
      await reader.close();
    }
  }, 60_000);

  it('upper case: the same message named in capitals on the other instance asks nothing more', async () => {
    const { db, business } = w.fixture;
    const asked = await question('Capitals?');
    const before = ollama.seen.length;
    const reader = connect(db.appUrl, { source: 'runtime' });
    ollama.shut();
    let asking: Promise<ConversationReply | null> | undefined;
    try {
      asking = first.exchange(reader, business, w.owner.presented, asked);
      await ollama.arrived(before + 1);
      const shouted = {
        conversationId: asked.conversationId.toUpperCase(),
        messageId: asked.messageId.toUpperCase(),
      };
      expect(
        await within(10_000, second.exchange(db.app, business, w.owner.presented, shouted)),
      ).toMatchObject({ answered: false, code: 'STILL_ANSWERING' });
      ollama.open();
      expect(await within(10_000, asking)).toMatchObject({ answered: true });
      expect(ollama.seen).toHaveLength(before + 1);
      expect((await callsFor(asked.conversationId)).map((one) => one.state)).toEqual(['settled']);
    } finally {
      ollama.open();
      await asking?.catch(() => null);
      await reader.close();
    }
  }, 60_000);

  it("scope: another business's call in flight neither answers for nor blocks this business's message", async () => {
    const { db, business } = w.fixture;
    const asked = await question('Mine, not theirs');
    const before = ollama.seen.length;
    // Another business with a carried call in flight on the same operation, on its own message.
    const other = await carriageBusiness(db.app, `other_${randomUUID().slice(0, 8)}`);
    expect(
      await within(10_000, second.exchange(db.app, business, w.owner.presented, asked)),
    ).toMatchObject({ answered: true, body: says(QWEN) });
    // This business's message named under the other business answers nothing there.
    expect(
      await within(
        10_000,
        first.exchange(db.app, other.id as typeof business, w.owner.presented, asked),
      ),
    ).toBeNull();
    expect(ollama.seen).toHaveLength(before + 1);
    const [theirs] = await db.admin.execute<{ readonly state: string }>(
      `select state from public.model_calls where id = $1`,
      [other.callId],
    );
    expect(theirs?.state).toBe('dispatched');
  }, 60_000);
});
