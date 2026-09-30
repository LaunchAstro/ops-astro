// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-03's idle sweep over a business, on a fresh Postgres: the deterministic
// pass that writes the wrap-up at quiet and purges a body after its window,
// through the real operations. Each case builds the conversations it names,
// runs one pass, and checks the report against the tables.
//
// Recovery is the ticket's line: a failed idle write leaves the body and
// nothing expires into a purge; the next pass writes the wrap-up. The failure
// here is a real one, a conversation another transaction holds past the
// pass's lock timeout.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  purgeConversation,
  sweepConversations,
  sweepPurgeOperationId,
  type SweepReport,
} from '../../packages/core-commands/src/index.ts';
import { writeBusinessSetting } from '../../packages/core-records/src/index.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  CODE_REVISION,
  conversationWorld,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, one pass per case
describe.skipIf(serverUrl === undefined)('AW-03 idle sweep', () => {
  let w: ConversationWorld;
  let second: Database;

  const on = async <T>(database: Database, work: (tx: TenantQuery) => Promise<T>): Promise<T> =>
    await database.withBusiness(w.fixture.business, work);
  const sweep = async (lockTimeoutMs?: number): Promise<SweepReport> =>
    await sweepConversations(w.fixture.db.app, {
      businessId: w.fixture.business,
      codeRevision: CODE_REVISION,
      ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
    });
  const count = async (sql: string, id: string): Promise<number> => await w.count(sql, [id]);
  const messages = async (id: string): Promise<number> =>
    await count(
      `select count(*) as n from public.conversation_messages where conversation_id = $1`,
      id,
    );
  const wrapUps = async (id: string): Promise<number> =>
    await count(
      `select count(*) as n from public.conversation_wrap_ups where conversation_id = $1`,
      id,
    );
  const window = async (days: number): Promise<void> => {
    await on(w.fixture.db.app, async (tx) => {
      await writeBusinessSetting(tx, { key: 'conversation_window_days', value: days });
    });
  };

  /** A task, completed eight days ago, and a conversation on it, `quietDays` quiet. */
  async function onSettledTask(subject: string, quietDays: number): Promise<string> {
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
    await w.fixture.db.admin.execute(
      `update public.records
          set data = jsonb_set(data, '{completed_at}', to_jsonb((now() - interval '8 days')::text))
        where id = $1`,
      [taskId],
    );
    await w.age(conversationId, quietDays);
    return conversationId;
  }

  /** Purge everything the earlier cases left due, so each case's report is its own. */
  async function settle(): Promise<void> {
    await window(7);
    await sweep();
    await sweep();
  }

  beforeAll(async () => {
    w = await conversationWorld('aw_03_sweep');
    second = connect(w.fixture.db.appUrl, { source: 'runtime' });
    await window(7);
  }, 120_000);

  afterAll(async () => {
    await second?.close();
    await w?.drop();
  });

  it('AW-03 recovery: one pass wraps what is quiet, leaves what is not, and purges nothing it wrapped in the same pass', async () => {
    await settle();
    const quiet = await started(w, w.owner, { body: 'Quiet for two days.' });
    await w.age(quiet, 2);
    const busy = await started(w, w.owner, { body: 'Still talking.' });
    const longQuiet = await onSettledTask('long-quiet', 8);

    const first = await sweep();
    expect(first.wrapped.toSorted()).toEqual([quiet, longQuiet].toSorted());
    expect(first.purged).toEqual([]);
    expect(first.failed).toEqual([]);
    expect(await wrapUps(busy)).toBe(0);
    expect(await messages(longQuiet)).toBe(1);

    const next = await sweep();
    expect(next.wrapped).toEqual([]);
    expect(next.purged).toEqual([longQuiet]);
    expect(await messages(longQuiet)).toBe(0);
    expect(await messages(quiet)).toBe(1);
    expect(await wrapUps(quiet)).toBe(1);
  });

  it('AW-03 recovery: open work holds the body and the pass says why', async () => {
    await settle();
    const created = await w.as(w.owner, 'task.create', { fields: { title: 'open task' } });
    const taskId = (created.body as { recordId: string }).recordId;
    const open = await started(w, w.owner, { scope: { kind: 'task', id: taskId }, body: 'Open.' });
    await w.age(open, 8);
    expect((await sweep()).wrapped).toEqual([open]);
    const held = await sweep();
    expect(held.purged).toEqual([]);
    expect(held.held).toEqual([{ conversationId: open, code: 'WORK_OPEN' }]);
    expect(await messages(open)).toBe(1);
  });

  it('AW-03 recovery: a failed idle write leaves the body, nothing expires into a purge, and the next pass writes the wrap-up', async () => {
    await settle();
    const stuck = await onSettledTask('stuck', 8);
    const report = await on(second, async (tx) => {
      // A real operation holds the conversation: a purge that refuses
      // (no wrap-up yet) and keeps its lock until this transaction ends.
      expect(
        await purgeConversation(tx, { conversationId: stuck, operationId: randomUUID() }),
      ).toEqual({
        ok: false,
        code: 'WRAP_UP_ABSENT',
      });
      return await sweep(200);
    });
    expect(report.failed).toEqual([{ conversationId: stuck, stage: 'wrap_up' }]);
    expect(report.wrapped).toEqual([]);
    expect(await wrapUps(stuck)).toBe(0);
    expect(await messages(stuck)).toBe(1);

    expect((await sweep()).wrapped).toEqual([stuck]);
    expect(await messages(stuck)).toBe(1);
    expect((await sweep()).purged).toEqual([stuck]);
  });

  it('AW-03 recovery: an unreadable window stops the purge for the business and the report shows the gap', async () => {
    await settle();
    const due = await onSettledTask('window-gap', 8);
    await sweep();
    await window(3);
    const gap = await sweep();
    expect(gap.windowUnreadable).toBe(true);
    expect(gap.purged).toEqual([]);
    expect(await messages(due)).toBe(1);
    await window(7);
    expect((await sweep()).purged).toEqual([due]);
  });

  it('AW-03 purge real: a pass retried after a lost answer asks for the same purge, and one audit event is written', async () => {
    await settle();
    const due = await onSettledTask('lost-answer', 8);
    await sweep();
    const lastActivity = (
      await w.fixture.db.admin.execute<{ readonly at: Date }>(
        `select last_activity_at as at from public.conversations where id = $1`,
        [due],
      )
    )[0]?.at;
    if (lastActivity === undefined) throw new Error('the conversation went');
    const operationId = sweepPurgeOperationId(due, lastActivity);
    expect(operationId).toBe(sweepPurgeOperationId(due, new Date(lastActivity.getTime())));
    expect((await sweep()).purged).toEqual([due]);
    expect(
      await on(
        w.fixture.db.app,
        async (tx) => await purgeConversation(tx, { conversationId: due, operationId }),
      ),
    ).toMatchObject({ ok: true, replayed: true });
    expect(
      await count(
        `select count(*) as n from public.audit_events where command = 'conversation.purge' and operation_id = $1`,
        operationId,
      ),
    ).toBe(1);
  });
});
