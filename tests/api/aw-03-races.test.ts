// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-03 under races and crashes, on a fresh Postgres.
//
// Two transactions at once on one conversation: the first holds the
// conversation's row lock through a real operation (a purge, a wrap-up) on a
// connection of its own; the second is started, seen waiting on that lock in
// `pg_stat_activity`, and answers only after the first commits. Each case
// checks what the second saw and what the tables hold afterwards. A pass
// dying mid-write is the real operation run inside a transaction that then
// fails: nothing it wrote survives, and the next pass does the work.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  purgeConversation,
  writeWrapUp,
  type PurgeOutcome,
  type WrapUpOutcome,
} from '../../packages/core-commands/src/index.ts';
import { writeBusinessSetting } from '../../packages/core-records/src/index.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { Answer } from './fixture.ts';
import {
  CODE_REVISION,
  conversationWorld,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, every race on it
describe.skipIf(serverUrl === undefined)('AW-03 races and recovery', () => {
  let w: ConversationWorld;
  let second: Database;

  const on = async <T>(database: Database, work: (tx: TenantQuery) => Promise<T>): Promise<T> =>
    await database.withBusiness(w.fixture.business, work);
  const wrapUpOn = async (database: Database, conversationId: string): Promise<WrapUpOutcome> =>
    await on(
      database,
      async (tx) => await writeWrapUp(tx, { conversationId, codeRevision: CODE_REVISION }),
    );
  const purgeOn = async (
    database: Database,
    conversationId: string,
    operationId = randomUUID(),
  ): Promise<PurgeOutcome> =>
    await on(database, async (tx) => await purgeConversation(tx, { conversationId, operationId }));
  const messages = async (conversationId: string): Promise<number> =>
    await w.count(
      `select count(*) as n from public.conversation_messages where conversation_id = $1`,
      [conversationId],
    );
  const wrapUps = async (conversationId: string): Promise<number> =>
    await w.count(
      `select count(*) as n from public.conversation_wrap_ups where conversation_id = $1`,
      [conversationId],
    );
  const purgeEvents = async (operationIds: readonly string[]): Promise<number> =>
    await w.count(
      `select count(*) as n from public.audit_events
        where command = 'conversation.purge' and operation_id = any($1::text[])`,
      [operationIds],
    );

  /** Waits until a backend in this database waits on a lock. */
  async function someoneWaits(): Promise<void> {
    for (let tries = 0; tries < 200; tries += 1) {
      // eslint-disable-next-line no-await-in-loop -- polling the server
      const n = await w.count(
        `select count(*) as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
        [],
      );
      if (n >= 1) return;
      // eslint-disable-next-line no-await-in-loop
      await sleep(25);
    }
    throw new Error('no backend ever waited on the conversation lock');
  }

  /**
   * `first` runs on its own connection and keeps its transaction open while
   * `racer` is started and seen waiting; `racer`'s answer comes after the commit.
   */
  async function whileHeld<A, B>(
    first: (tx: TenantQuery) => Promise<A>,
    racer: () => Promise<B>,
  ): Promise<{ first: A; racer: B }> {
    let waiting: Promise<B> | undefined;
    const held = await on(second, async (tx) => {
      const outcome = await first(tx);
      waiting = racer();
      await someoneWaits();
      return outcome;
    });
    if (waiting === undefined) throw new Error('the second transaction never started');
    return { first: held, racer: await waiting };
  }

  /** A conversation on a completed task, eight days quiet, with its wrap-up: due for purge. */
  async function dueForPurge(subject: string): Promise<string> {
    const created = await w.as(w.owner, 'task.create', { fields: { title: `${subject} task` } });
    const taskId = (created.body as { recordId: string }).recordId;
    const conversationId = await started(w, w.owner, {
      scope: { kind: 'task', id: taskId },
      body: `The ${subject} request.`,
    });
    const task = await w.as(w.owner, 'task.read', { recordId: taskId });
    const revision = (task.body['task'] as { revision: number }).revision;
    const done = await w.as(w.owner, 'task.complete', {
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: revision,
    });
    expect(done.status).toBe(200);
    await w.age(conversationId, 8);
    await w.fixture.db.admin.execute(
      `update public.records
          set data = jsonb_set(data, '{completed_at}', to_jsonb((now() - interval '8 days')::text))
        where id = $1`,
      [taskId],
    );
    expect(await wrapUpOn(w.fixture.db.app, conversationId)).toMatchObject({
      ok: true,
      written: true,
    });
    return conversationId;
  }

  beforeAll(async () => {
    w = await conversationWorld('aw_03_races');
    second = connect(w.fixture.db.appUrl, { source: 'runtime' });
    await on(w.fixture.db.app, async (tx) => {
      await writeBusinessSetting(tx, { key: 'conversation_window_days', value: 7 });
    });
  }, 120_000);

  afterAll(async () => {
    await second?.close();
    await w?.drop();
  });

  it('AW-03 purge real: a message racing the purge waits on the conversation lock and is refused; no message lands in a purged body', async () => {
    const conversationId = await dueForPurge('message-race');
    const race = await whileHeld(
      async (tx) => await purgeConversation(tx, { conversationId, operationId: randomUUID() }),
      async (): Promise<Answer> =>
        await w.as(w.owner, 'conversation.message', { conversationId, body: 'One more thing.' }),
    );
    expect(race.first).toMatchObject({ ok: true, replayed: false, messagesPurged: 1 });
    expect((race.racer.body as { code?: string }).code).toBe('TRANSITION_NOT_PERMITTED');
    expect(await messages(conversationId)).toBe(0);
  });

  it('AW-03 purge real: a message racing the wrap-up lands after it, and the purge then refuses WRAP_UP_ABSENT and keeps the body', async () => {
    const conversationId = await started(w, w.owner, { body: 'Wrap me while I type.' });
    await w.age(conversationId, 8);
    const race = await whileHeld(
      async (tx) => await writeWrapUp(tx, { conversationId, codeRevision: CODE_REVISION }),
      async (): Promise<Answer> =>
        await w.as(w.owner, 'conversation.message', { conversationId, body: 'Still here.' }),
    );
    expect(race.first).toMatchObject({ ok: true, version: 1, written: true });
    expect(race.racer.status).toBe(200);
    expect(await purgeOn(w.fixture.db.app, conversationId)).toEqual({
      ok: false,
      code: 'WRAP_UP_ABSENT',
    });
    expect(await messages(conversationId)).toBe(2);
    expect(await wrapUpOn(w.fixture.db.app, conversationId)).toEqual({
      ok: false,
      reason: 'not_quiet',
    });
  });

  it('AW-03 purge real: two purges at once with different operation ids are one purge and one audit event', async () => {
    const conversationId = await dueForPurge('two-purges');
    const [a, b] = [randomUUID(), randomUUID()];
    const race = await whileHeld(
      async (tx) => await purgeConversation(tx, { conversationId, operationId: a }),
      async () => await purgeOn(w.fixture.db.app, conversationId, b),
    );
    expect(race.first).toMatchObject({ ok: true, replayed: false });
    expect(race.racer).toMatchObject({ ok: true, replayed: true, messagesPurged: 0 });
    expect(await purgeEvents([a, b])).toBe(1);
    expect(await purgeEvents([a])).toBe(1);
    expect(
      await w.count(
        `select count(*) as n from public.conversations where id = $1 and purge_operation_id = $2`,
        [conversationId, a],
      ),
    ).toBe(1);
  });

  it('AW-03 purge real: a wrap-up covers its conversation’s last activity as the database holds it, to the microsecond', async () => {
    const conversationId = await started(w, w.owner, { body: 'Exact to the microsecond.' });
    await w.age(conversationId, 2);
    await w.fixture.db.admin.execute(
      `update public.conversations
          set last_activity_at = date_trunc('millisecond', last_activity_at) + interval '1123 microseconds'
        where id = $1`,
      [conversationId],
    );
    expect(await wrapUpOn(w.fixture.db.app, conversationId)).toMatchObject({ written: true });
    expect(
      await w.count(
        `select count(*) as n from public.conversation_wrap_ups u
           join public.conversations c on c.business_id = u.business_id and c.id = u.conversation_id
          where c.id = $1 and u.activity_through = c.last_activity_at`,
        [conversationId],
      ),
    ).toBe(1);
  });

  it('AW-03 recovery: two idle passes at once write one wrap-up version', async () => {
    const conversationId = await started(w, w.owner, { body: 'Two passes.' });
    await w.age(conversationId, 2);
    const race = await whileHeld(
      async (tx) => await writeWrapUp(tx, { conversationId, codeRevision: CODE_REVISION }),
      async () => await wrapUpOn(w.fixture.db.app, conversationId),
    );
    expect(race.first).toEqual({ ok: true, version: 1, written: true });
    expect(race.racer).toEqual({ ok: true, version: 1, written: false });
    expect(await wrapUps(conversationId)).toBe(1);
  });

  it('AW-03 recovery: an idle pass dying mid-write leaves nothing half-written, and the next pass writes the wrap-up', async () => {
    const conversationId = await started(w, w.owner, { body: 'Die mid-write.' });
    await w.age(conversationId, 2);
    await expect(
      on(w.fixture.db.app, async (tx) => {
        await writeWrapUp(tx, { conversationId, codeRevision: CODE_REVISION });
        throw new Error('the pass died after its write');
      }),
    ).rejects.toThrow('the pass died');
    expect(await wrapUps(conversationId)).toBe(0);
    expect(await wrapUpOn(w.fixture.db.app, conversationId)).toEqual({
      ok: true,
      version: 1,
      written: true,
    });
  });

  it('AW-03 purge real: a purge dying after its delete leaves the body whole and no audit event; a half-purged conversation is unreachable', async () => {
    const conversationId = await dueForPurge('half-purge');
    const operationId = randomUUID();
    await expect(
      on(w.fixture.db.app, async (tx) => {
        const outcome = await purgeConversation(tx, { conversationId, operationId });
        expect(outcome).toMatchObject({ ok: true, messagesPurged: 1 });
        throw new Error('the purge died before its commit');
      }),
    ).rejects.toThrow('the purge died');
    expect(await messages(conversationId)).toBe(1);
    expect(await purgeEvents([operationId])).toBe(0);
    const read = await w.as(w.owner, 'conversation.read', { conversationId });
    expect(read.status).toBe(200);
    expect(
      (read.body as { conversation: { bodyPurgedAt: string | null } }).conversation.bodyPurgedAt,
    ).toBeNull();
    // The lost answer's retry is the same purge, once.
    expect(await purgeOn(w.fixture.db.app, conversationId, operationId)).toMatchObject({
      ok: true,
      replayed: false,
    });
    expect(await purgeOn(w.fixture.db.app, conversationId, operationId)).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(await purgeEvents([operationId])).toBe(1);
  });
});
