// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R1, `sol-1623-terminal-with-zero-model-calls`: an attempt that stops
// before its first model call still ends in exactly one named outcome, written
// by the transaction that stopped it (design R1). A person's cancel writes
// `cancelled / TASK_CANCELLED` in the cancel; a worker lost before its first
// call is fenced by the expiry sweep, which writes `lease_lost /
// LEASE_EXPIRED`. A live attempt that has simply not called yet gets no row
// from any writer.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepExpiredLeases } from '../../packages/core-runtime/src/recovery/sweep.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  appliedDetail,
  asPerson,
  liveWork,
  openSchedules,
  scalar,
  type Schedules,
  type Work,
} from '../runtime/schedules-harness.ts';
import { attemptOfLease, outcomesOfAttempt } from './run-outcomes-read.ts';

const outcomesOf = async (s: Schedules, work: Work) => {
  const { attemptId } = await attemptOfLease(
    s.db.admin,
    s.business,
    String(work.picked['leaseId']),
  );
  return await outcomesOfAttempt(s.db.admin, s.business, attemptId);
};

const modelCallsOf = async (s: Schedules, work: Work): Promise<number> =>
  await scalar(
    s,
    `select count(*)::text as n from public.model_calls where business_id = $1 and lease_id = $2`,
    [s.business, work.picked['leaseId']],
  );

// eslint-disable-next-line max-lines-per-function -- one world, three stops
describe.skipIf(databaseUrlFromEnvironment() === undefined)('stops before the first call', () => {
  let s: Schedules;
  beforeAll(async () => {
    s = await openSchedules('r1zero', 100_000);
  }, 120_000);
  afterAll(async () => {
    await s?.db.drop();
  });

  it('a cancel before the first model call records cancelled / TASK_CANCELLED for the attempt, once', async () => {
    const work = await liveWork(s, 'cancelled before its first call', 1_000);
    expect(await modelCallsOf(s, work)).toBe(0);

    appliedDetail(
      await asPerson(s, {
        command: 'task.cancel',
        operationId: randomUUID(),
        recordId: work.taskId,
        lineageId: work.proposal['lineageId'],
        reason: 'stopped before any model call',
      }),
      'cancel',
    );

    const stored = await outcomesOf(s, work);
    expect(stored.map((row) => [row.outcome, row.end_code, row.stop_cause])).toStrictEqual([
      ['cancelled', 'TASK_CANCELLED', null],
    ]);
    expect(stored[0]?.planned_run_id).toBe(String(work.picked['runId']));
    // The cancel retired the work as it did before: no live lease is left.
    expect(
      await scalar(
        s,
        `select count(*)::text as n from public.leases where business_id = $1 and id = $2 and state = 'live'`,
        [s.business, work.picked['leaseId']],
      ),
    ).toBe(0);
  });

  it('a worker lost before its first model call is fenced by the sweep, which records lease_lost / LEASE_EXPIRED once', async () => {
    const work = await liveWork(s, 'lost before its first call', 1_000);
    await s.db.admin.execute(
      `update public.leases set expires_at = now() - interval '1 second'
        where business_id = $1 and id = $2`,
      [s.business, work.picked['leaseId']],
    );

    await s.db.app.withBusiness(s.business, async (tx) => await sweepExpiredLeases(tx));
    // A second sweep finds the row and writes nothing more.
    await s.db.app.withBusiness(s.business, async (tx) => await sweepExpiredLeases(tx));

    const stored = await outcomesOf(s, work);
    expect(stored.map((row) => [row.outcome, row.end_code])).toStrictEqual([
      ['lease_lost', 'LEASE_EXPIRED'],
    ]);
    expect(await modelCallsOf(s, work)).toBe(0);
  });

  it('control: a live attempt that has not called yet gets no outcome, from the sweep or anything else', async () => {
    const work = await liveWork(s, 'live and idle', 1_000);
    await s.db.app.withBusiness(s.business, async (tx) => await sweepExpiredLeases(tx));

    expect(await outcomesOf(s, work)).toStrictEqual([]);
    expect(
      await scalar(
        s,
        `select count(*)::text as n from public.leases where business_id = $1 and id = $2 and state = 'live'`,
        [s.business, work.picked['leaseId']],
      ),
    ).toBe(1);
  });
});
