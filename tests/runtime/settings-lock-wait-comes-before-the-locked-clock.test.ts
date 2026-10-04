// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { useAw06World, w } from './aw-06-world.ts';
import { leased, marked } from './aw-08-gate-world.ts';
import {
  asAgent,
  asPerson,
  awaitParked,
  barrier,
  codeOf,
  racer,
  rows,
  waitPast,
} from './schedules-harness.ts';

useAw06World('settings_clock');

// eslint-disable-next-line max-lines-per-function -- one schedule: install held, the command parked, the expiry passed, then released
it('dispatch refuses a lease and delegation expired during the settings install lock wait', async () => {
  const owner = w.s;
  const work = await leased(owner, 'launch', 'Sol settings wait expiry');
  const leaseId = String(work.picked['leaseId']);
  expect(
    await rows(owner, `select id from public.business_settings where business_id = $1`, [
      owner.business,
    ]),
  ).toEqual([]);
  await owner.db.admin.execute(
    `with lease as (
       update public.leases set expires_at = clock_timestamp() + interval '3 seconds'
        where business_id = $1 and id = $2 returning delegation_id, expires_at)
     update public.delegations d set expires_at = lease.expires_at
       from lease where d.business_id = $1 and d.id = lease.delegation_id`,
    [owner.business, leaseId],
  );
  const installer = racer(owner);
  const dispatcher = racer(owner);
  const installed = barrier();
  const finishInstall = barrier();
  const installing = installer.withBusiness(owner.business, async (tx) => {
    await installBusinessSettings(tx);
    installed.release();
    await finishInstall.held;
  });
  await installed.held;
  const dispatching = asAgent(
    owner,
    {
      command: 'task.dispatch',
      operationId: randomUUID(),
      leaseId,
      fence: work.picked['fence'],
    },
    work.credential,
    dispatcher,
  );
  try {
    await awaitParked(owner, 'advisory', 1);
    const waiting = await rows<{ query: string }>(
      owner,
      `select a.query from pg_stat_activity a
         join pg_locks l on l.pid = a.pid
        where a.datname = current_database() and l.locktype = 'advisory'
          and not l.granted`,
      [],
    );
    expect(waiting.map((row) => row.query)).toEqual([
      'select pg_advisory_xact_lock_shared(hashtextextended($1, 0))',
    ]);
    await waitPast(owner, 'select expires_at from public.leases where id = $1', leaseId);
    finishInstall.release();
    await installing;
    const answer = await dispatching;
    expect
      .soft(codeOf(answer), 'expired authority cannot release an effect')
      .toBe('AUTHORITY_LOST');
    expect.soft(await marked(owner, work.taskId), 'no marker may commit after expiry').toBe(0);
  } finally {
    finishInstall.release();
    await Promise.allSettled([installing, dispatching]);
    await installer.close();
    await dispatcher.close();
  }
}, 30_000);

// eslint-disable-next-line max-lines-per-function -- one schedule: install held, the command parked, the expiry passed, then released
it('a top-up cannot raise money after its billing grant expires during the first settings install wait', async () => {
  const owner = w.s;
  // Fixture-only deletion restores the pre-install state on this disposable database.
  await owner.db.admin.execute('delete from public.business_settings where business_id = $1', [
    owner.business,
  ]);
  const work = await leased(owner, 'launch', 'Sol settings wait billing expiry');
  const [before] = await rows<{ maximum: string }>(
    owner,
    `select maximum_minor::text as maximum from public.task_envelopes
      where business_id = $1 and task_id = $2 and state = 'open'`,
    [owner.business, work.taskId],
  );
  if (before === undefined) throw new Error('fixture has no envelope');
  const [grant] = await owner.db.admin.execute<{ id: string }>(
    `update public.grants set expires_at = clock_timestamp() + interval '3 seconds'
      where business_id = $1 and collection = 'billing' and action = 'decide'
        and subject_kind = 'person' and subject_id = $2 returning id`,
    [owner.business, owner.decider.personId],
  );
  if (grant === undefined) throw new Error('fixture has no billing grant');
  const installer = racer(owner);
  const approver = racer(owner);
  const installed = barrier();
  const finishInstall = barrier();
  const installing = installer.withBusiness(owner.business, async (tx) => {
    await installBusinessSettings(tx);
    installed.release();
    await finishInstall.held;
  });
  await installed.held;
  const topping = asPerson(
    owner,
    {
      command: 'budget.top_up',
      operationId: randomUUID(),
      recordId: work.taskId,
      amountMinor: 10_000,
      fromMaximumMinor: Number(before.maximum),
    },
    approver,
  );
  try {
    await awaitParked(owner, 'advisory', 1);
    const waiting = await rows<{ query: string }>(
      owner,
      `select a.query from pg_stat_activity a join pg_locks l on l.pid = a.pid
        where a.datname = current_database() and l.locktype = 'advisory' and not l.granted`,
      [],
    );
    expect(waiting.map((row) => row.query)).toEqual([
      'select pg_advisory_xact_lock_shared(hashtextextended($1, 0))',
    ]);
    await waitPast(owner, 'select expires_at from public.grants where id = $1', grant.id);
    finishInstall.release();
    await installing;
    const answer = await topping;
    expect
      .soft(codeOf(answer), 'a billing grant must be live after the lock wait')
      .toBe('SCOPE_NOT_GRANTED');
    expect
      .soft(
        await rows(
          owner,
          `select maximum_minor::text as maximum from public.task_envelopes
        where business_id = $1 and task_id = $2 and state = 'open'`,
          [owner.business, work.taskId],
        ),
        'the expired grant must raise no money',
      )
      .toEqual([before]);
  } finally {
    finishInstall.release();
    await Promise.allSettled([installing, topping]);
    await installer.close();
    await approver.close();
  }
}, 30_000);
