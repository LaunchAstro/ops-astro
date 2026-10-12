// SPDX-License-Identifier: AGPL-3.0-only
//
// A task created from a conversation is activity there. Here it races the
// wrap-up and the purge, each on a connection of its own, in both orders.
// After both commit, the wrap-up does not cover the conversation or lists the
// task, a purge never lets go a body whose new task its wrap-up misses, and
// no task names a purged conversation. Every wait is read from
// `pg_stat_activity`, never assumed after a sleep; for the create-first
// order, the create is stopped after its write by holding the audit chain's
// lock on a third connection.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  purgeConversation,
  writeWrapUp,
  type PurgeOutcome,
  type WrapUpOutcome,
} from '../../packages/core-commands/src/index.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, waiterOf } from '../support/lock-wait-race.ts';
import type { Answer } from './fixture.ts';
import {
  CODE_REVISION,
  conversationWorld,
  setConversationWindow,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'api/a-task-created-while-the-wrap-up-or-purge-holds-its-conversation-is-covered-or-listed: DATABASE_URL is unset, so nothing below ran.',
  );
}

interface ServedWrapUp {
  readonly items: readonly { key: string; pointers: readonly { id: string }[] }[];
}
const written = (version: number) => ({ ok: true, version, written: true });
const NOT_QUIET = { ok: false, reason: 'not_quiet' };
const STALE = { ok: false, code: 'WRAP_UP_ABSENT' };

// eslint-disable-next-line max-lines-per-function -- one world, every order on it
describe.skipIf(serverUrl === undefined)('a task created while its conversation is held', () => {
  let w: ConversationWorld;
  let second: Database;

  const on = async <T>(database: Database, work: (tx: TenantQuery) => Promise<T>): Promise<T> =>
    await database.withBusiness(w.fixture.business, work);
  const wrapUpOn = async (database: Database, conversationId: string): Promise<WrapUpOutcome> =>
    await on(
      database,
      async (tx) => await writeWrapUp(tx, { conversationId, codeRevision: CODE_REVISION }),
    );
  const purgeOn = async (database: Database, conversationId: string): Promise<PurgeOutcome> =>
    await on(
      database,
      async (tx) => await purgeConversation(tx, { conversationId, operationId: randomUUID() }),
    );
  const create = async (conversationId: string, title: string): Promise<Answer> =>
    await w.as(w.owner, 'task.create', { fields: { title }, conversationId });
  /** Tasks whose creation names the conversation as its origin. */
  const originTasks = async (conversationId: string): Promise<number> =>
    await w.count(
      `select count(*) as n from public.audit_events
        where command = 'task.create' and origin_conversation_id = $1`,
      [conversationId],
    );
  const tasksCreated = async (conversationId: string): Promise<readonly string[]> => {
    const read = await w.as(w.owner, 'conversation.read', { conversationId });
    expect(read.status).toBe(200);
    const wrapUp = read.body['wrapUp'] as ServedWrapUp;
    return (
      wrapUp.items
        .find((item) => item.key === 'tasks_created')
        ?.pointers.map((pointer) => pointer.id) ?? []
    );
  };

  /** A backend of this database waiting on a lock `pid` holds: its pid. */
  async function waitingOn(pid: number): Promise<number> {
    for (let tries = 0; tries < 400; tries += 1) {
      // eslint-disable-next-line no-await-in-loop -- polling the server
      const rows = await w.fixture.db.admin.execute<{ readonly pid: number }>(
        `select a.pid from pg_stat_activity a
          where a.datname = current_database() and a.wait_event_type = 'Lock'
            and $1::int = any(pg_blocking_pids(a.pid))`,
        [pid],
      );
      const found = rows[0]?.pid;
      if (found !== undefined) return Number(found);
      // eslint-disable-next-line no-await-in-loop
      await sleep(25);
    }
    throw new Error(`nothing ever waited on backend ${String(pid)}`);
  }

  /**
   * `first` holds the conversation on the second connection; the create is
   * started, seen waiting on it, and answers after `first` commits.
   */
  async function createWhileHeld<A>(
    first: (tx: TenantQuery) => Promise<A>,
    conversationId: string,
    title: string,
  ): Promise<{ first: A; created: Answer }> {
    let creating: Promise<Answer> | undefined;
    const held = await on(second, async (tx) => {
      const outcome = await first(tx);
      const [me] = await tx.query<{ readonly pid: number }>('select pg_backend_pid() as pid');
      creating = create(conversationId, title);
      await waitingOn(Number(me?.pid));
      return outcome;
    });
    if (creating === undefined) throw new Error('the create never started');
    return { first: held, created: await creating };
  }

  /**
   * The create stopped after its write to the conversation, its transaction
   * open; `racer` is started on the second connection and seen waiting on the
   * create; then the create commits and `racer` answers.
   */
  async function racingACreate<B>(
    conversationId: string,
    title: string,
    racer: () => Promise<B>,
  ): Promise<{ created: Answer; racer: B }> {
    const chain = await hold(w.fixture.db, async (execute) => {
      await execute('select pg_advisory_xact_lock(hashtextextended($1::uuid::text, 0))', [
        w.fixture.business,
      ]);
    });
    let creating: Promise<Answer> | undefined;
    let racing: Promise<B> | undefined;
    try {
      creating = create(conversationId, title);
      await waiterOf(w.fixture.db, chain);
      const creator = await waitingOn(chain.pid);
      // Past its own write: the update's lock on the table is the create's.
      expect(
        await w.count(
          `select count(*) as n from pg_locks
            where pid = $1 and relation = 'public.conversations'::regclass
              and mode = 'RowExclusiveLock' and granted`,
          [creator],
        ),
      ).toBe(1);
      racing = racer();
      expect(await waitingOn(creator)).toBeGreaterThan(0);
    } finally {
      await chain.letGo();
    }
    return { created: await creating, racer: await racing };
  }

  /** A conversation eight days quiet with its wrap-up written: due for purge. */
  async function wrappedAndDue(body: string): Promise<string> {
    const conversationId = await started(w, w.owner, { body });
    await w.age(conversationId, 8);
    expect(await wrapUpOn(w.fixture.db.app, conversationId)).toEqual(written(1));
    return conversationId;
  }

  beforeAll(async () => {
    w = await conversationWorld('task_create_held');
    second = connect(w.fixture.db.appUrl, { source: 'runtime' });
    await on(w.fixture.db.app, async (tx) => {
      await setConversationWindow(tx, 7);
    });
  }, 180_000);

  afterAll(async () => {
    await second?.close();
    await w?.drop();
  });

  it('a create waiting on the wrap-up lands after it: that wrap-up no longer covers, and the next lists the task', async () => {
    const conversationId = await started(w, w.owner, { body: 'Wrap me while I make a task.' });
    await w.age(conversationId, 8);
    const race = await createWhileHeld(
      async (tx) => await writeWrapUp(tx, { conversationId, codeRevision: CODE_REVISION }),
      conversationId,
      'made while the wrap-up held',
    );
    expect(race.first).toEqual({ ok: true, version: 1, written: true });
    expect(race.created.status, JSON.stringify(race.created.body)).toBe(200);
    const taskId = (race.created.body as { recordId: string }).recordId;
    expect(await purgeOn(w.fixture.db.app, conversationId)).toEqual(STALE);
    expect(await wrapUpOn(w.fixture.db.app, conversationId)).toEqual(NOT_QUIET);
    await w.age(conversationId, 8);
    expect(await wrapUpOn(w.fixture.db.app, conversationId)).toEqual(written(2));
    expect(await tasksCreated(conversationId)).toEqual([taskId]);
  });

  it('a wrap-up waiting on a create finds the conversation active and writes nothing; the next lists the task', async () => {
    const conversationId = await started(w, w.owner, { body: 'Make a task while I wrap.' });
    await w.age(conversationId, 8);
    const race = await racingACreate(
      conversationId,
      'made while the wrap-up waited',
      async () => await wrapUpOn(second, conversationId),
    );
    expect(race.created.status, JSON.stringify(race.created.body)).toBe(200);
    const taskId = (race.created.body as { recordId: string }).recordId;
    expect(race.racer).toEqual(NOT_QUIET);
    await w.age(conversationId, 8);
    expect(await wrapUpOn(w.fixture.db.app, conversationId)).toEqual(written(1));
    expect(await tasksCreated(conversationId)).toEqual([taskId]);
  });

  it('a create waiting on the purge is refused, and no task names the purged conversation', async () => {
    const conversationId = await wrappedAndDue('Purge me while I make a task.');
    const race = await createWhileHeld(
      async (tx) => await purgeConversation(tx, { conversationId, operationId: randomUUID() }),
      conversationId,
      'made while the purge held',
    );
    expect(race.first).toMatchObject({ ok: true, replayed: false, messagesPurged: 1 });
    expect(race.created.status).toBe(404);
    expect((race.created.body as { code?: string }).code).toBe('NOT_FOUND');
    expect(await originTasks(conversationId)).toBe(0);
    expect(
      await w.count(
        `select count(*) as n from public.records where data ->> 'title' = 'made while the purge held'`,
        [],
      ),
    ).toBe(0);
  });

  it('a purge waiting on a create finds the wrap-up stale and keeps the body', async () => {
    const conversationId = await wrappedAndDue('Make a task while I purge.');
    const race = await racingACreate(
      conversationId,
      'made while the purge waited',
      async () => await purgeOn(second, conversationId),
    );
    expect(race.created.status, JSON.stringify(race.created.body)).toBe(200);
    expect(race.racer).toEqual(STALE);
    expect(
      await w.count(
        'select count(*) as n from public.conversation_messages where conversation_id = $1',
        [conversationId],
      ),
    ).toBe(1);
    expect(await originTasks(conversationId)).toBe(1);
  });

  it('a create stamps the activity on the clock after its wait, past a message kept while it waited', async () => {
    const conversationId = await started(w, w.owner, { body: 'Hold me while I make a task.' });
    await w.age(conversationId, 8);
    const held = await hold(
      w.fixture.db,
      async (execute) => {
        await execute('select id from public.conversations where id = $1 for update', [
          conversationId,
        ]);
      },
      async (execute) => {
        const [kept] = await execute<{ readonly at: string }>(
          `update public.conversations set last_activity_at = clock_timestamp()
            where id = $1 returning last_activity_at::text as at`,
          [conversationId],
        );
        return kept?.at;
      },
    );
    const creating = create(conversationId, 'made after a held row');
    let began: string;
    let keptAt: string | undefined;
    try {
      began = await waiterOf(w.fixture.db, held);
    } finally {
      keptAt = await held.letGo();
    }
    const created = await creating;
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    // As text: a timestamptz bound through a JavaScript Date keeps milliseconds only.
    const [after] = await w.fixture.db.admin.execute<{
      readonly beganFirst: boolean;
      readonly advanced: boolean;
    }>(
      `select $2::text::timestamptz < $3::text::timestamptz as "beganFirst",
              c.last_activity_at > $3::text::timestamptz as advanced
         from public.conversations c where c.id = $1`,
      [conversationId, began, keptAt],
    );
    expect(after).toEqual({ beganFirst: true, advanced: true });
  }, 60_000);
});
