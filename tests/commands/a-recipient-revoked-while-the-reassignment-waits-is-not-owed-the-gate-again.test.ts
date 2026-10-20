// SPDX-License-Identifier: AGPL-3.0-only
//
// A reassignment judges who is owed an escalated gate after it has waited for
// the task, on two separate connections. A second connection holds the task's
// row; the reassignment starts and waits on it; the recipient's business-wide
// `decide` is revoked and committed while it waits; the row is released. The
// reassignment reads the holders after its wait, so the stored recipient, no
// longer a decider, keeps their item withdrawn. A reassignment that crashes at
// the reopen changes nothing, and the same one sent again reopens it once.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo } from './fixture.ts';
import {
  appliedDetail,
  asPerson,
  createTask,
  openSchedules,
  propose,
  revisionOf,
  rows,
  type Body,
  type Detail,
  type Schedules,
} from '../runtime/schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

const decideBody = (version: Detail, decision: string, extra: Body = {}): Body => ({
  command: 'task.decide',
  operationId: randomUUID(),
  gateId: version['gateId'],
  versionId: version['versionId'],
  decision,
  note: `${decision} while the reassignment waits`,
  ...extra,
});

/** A promise and the call that settles it. */
function latch(): { readonly promise: Promise<void>; readonly open: () => void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, open: () => settle?.() };
}

// eslint-disable-next-line max-lines-per-function -- one database world, the staged wait and its case
describe.skipIf(serverUrl === undefined)('a reassignment waiting on its task', () => {
  let s: Schedules;
  let holderDb: Database | undefined;

  beforeAll(async () => {
    s = await openSchedules('escalated_waits', 1_000_000);
    holderDb = connect(s.db.appUrl, { source: 'runtime' });
  }, 180_000);

  afterAll(async () => {
    await holderDb?.close();
    await s?.db.drop();
  });

  const assignBody = async (taskId: string, assignee: string): Promise<Body> => ({
    command: 'task.assign',
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revisionOf(s, taskId),
    fields: { assignee },
  });

  async function itemState(gateId: unknown, person: string): Promise<string | undefined> {
    const found = await rows<{ readonly state: string }>(
      s,
      `select work_state as state from public.inbox_items
        where business_id = $1 and reason = 'decision' and fact_kind = 'gate' and fact_id = $2
          and recipient_person_id = $3
        order by work_state = 'open' desc limit 1`,
      [s.business, gateId, person],
    );
    return found[0]?.state;
  }

  /** Waits until some backend is blocked on `holder`, so the race is staged, not hoped for. */
  async function someoneBlockedBy(holder: number): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      // oxlint-disable-next-line no-await-in-loop -- one probe at a time until the wait shows
      const waiting = await s.db.admin.execute(
        'select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))',
        [holder],
      );
      if (waiting.length > 0) return;
      // oxlint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    throw new Error(`nothing blocked on backend ${holder} within 30 s`);
  }

  /** A task whose gate is escalated to a business decider, who is then assigned the task. */
  async function escalatedToTheAssignee() {
    const recipient = await enrol(s.db.app, s.business, `recipient-${randomUUID()}`);
    const decideGrant = await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, recipient, 'read');
      return await grantTo(tx, recipient, 'decide');
    });
    const taskId = await createTask(s, `escalated recipient waits ${randomUUID()}`);
    const v1 = await propose(s, taskId);
    appliedDetail(await asPerson(s, decideBody(v1, 'request_changes')), 'round 1');
    const v2 = await propose(s, taskId, { lineageId: String(v1['lineageId']) });
    appliedDetail(await asPerson(s, decideBody(v2, 'request_changes')), 'round 2');
    const v3 = await propose(s, taskId, { lineageId: String(v1['lineageId']) });
    appliedDetail(
      await asPerson(s, decideBody(v3, 'escalate', { recipientPersonId: recipient.personId })),
      'escalate',
    );
    appliedDetail(await asPerson(s, await assignBody(taskId, recipient.personId)), 'assign');
    expect(await itemState(v3['gateId'], recipient.personId)).toBe('withdrawn');
    return { taskId, gateId: v3['gateId'], recipient, decideGrant };
  }

  it('a recipient whose decide is revoked while the reassignment waits on the task is not owed the gate again', async () => {
    const { taskId, gateId, recipient, decideGrant } = await escalatedToTheAssignee();
    if (holderDb === undefined) throw new Error('no second connection');

    const holding = latch();
    const release = latch();
    let holder = 0;
    const taskRow = holderDb.withBusiness(s.business, async (tx) => {
      const [pid] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
      holder = pid?.pid ?? 0;
      await tx.query('select 1 from public.records where id = $1::uuid for update', [taskId]);
      holding.open();
      await release.promise;
    });
    await holding.promise;
    const reassign = asPerson(s, await assignBody(taskId, s.decider.personId));
    try {
      await someoneBlockedBy(holder);
      await s.db.admin.execute(
        'update public.grants set revoked_at = clock_timestamp() where id = $1',
        [decideGrant],
      );
    } finally {
      release.open();
      await taskRow;
    }
    appliedDetail(await reassign, 'reassign');
    expect(await itemState(gateId, recipient.personId)).toBe('withdrawn');
  }, 120_000);
  it('a reassignment that fails as it reopens a recipient’s item changes nothing, and sent again reopens it once', async () => {
    const { taskId, gateId, recipient } = await escalatedToTheAssignee();
    const revision = await revisionOf(s, taskId);
    const body = await assignBody(taskId, s.decider.personId);
    // A crash at exactly the reopen: the one update that moves a withdrawn item back to open.
    await s.db.admin.execute(
      `create or replace function public.crash_at_reopen() returns trigger language plpgsql as $$
       begin raise exception 'planted crash at reopen'; end $$`,
      [],
    );
    await s.db.admin.execute(
      `create trigger crash_at_reopen before update on public.inbox_items for each row
         when (old.work_state = 'withdrawn' and new.work_state = 'open')
         execute function public.crash_at_reopen()`,
      [],
    );
    let crashed: unknown;
    try {
      crashed = await asPerson(s, body).then(
        (result) => result,
        (cause: unknown) => cause,
      );
    } finally {
      await s.db.admin.execute('drop trigger crash_at_reopen on public.inbox_items', []);
      await s.db.admin.execute('drop function public.crash_at_reopen()', []);
    }
    expect(String(crashed)).toContain('planted crash at reopen');
    expect(await revisionOf(s, taskId)).toBe(revision);
    expect(await itemState(gateId, recipient.personId)).toBe('withdrawn');

    const applied = await asPerson(s, body);
    appliedDetail(applied, 'reassign after the crash');
    expect(await itemState(gateId, recipient.personId)).toBe('open');
    const after = await revisionOf(s, taskId);
    // The response is lost and the same reassignment is sent again: nothing moves twice.
    expect(await asPerson(s, body)).toStrictEqual(applied);
    expect(await revisionOf(s, taskId)).toBe(after);
    const open = await rows<{ readonly count: number }>(
      s,
      `select count(*)::int as count from public.inbox_items
        where business_id = $1 and reason = 'decision' and fact_kind = 'gate' and fact_id = $2
          and recipient_person_id = $3 and work_state = 'open'`,
      [s.business, gateId, recipient.personId],
    );
    expect(open[0]?.count).toBe(1);
  }, 120_000);
});
