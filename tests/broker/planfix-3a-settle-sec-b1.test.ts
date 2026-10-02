// SPDX-License-Identifier: AGPL-3.0-only
//
// PLANFIX-3A settle, security finding B1: a hold the classifier keeps for an
// unknown model call goes to a person, and "nothing happened" released it
// with no actual and re-held the whole ceiling, so a call settled on it
// reached neither the envelope nor the cap. The release settles the hold at
// what its settled calls cost, and the step resumes on what is left.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import { sweepDeployment } from '../../apps/api/recovery-entry.ts';
import { appliedDetail, asPerson, liveWork, type Work } from '../runtime/schedules-harness.ts';
import { openBilling } from '../runtime/t3d1-harness.ts';
import { call, noDatabase, s, useBrokerWorld, world } from './broker-world.ts';
import { moneyOf, one } from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('pf3asecb1');
// Budget permission for the decider, as a person's outcome needs.
beforeAll(async () => {
  if (!noDatabase) await openBilling(s);
});

const runOf = async (work: Work): Promise<string> =>
  (
    await one<{ run_id: string }>(`select run_id from public.leases where id = $1`, [
      work.picked['leaseId'],
    ])
  ).run_id;

const resolve = async (key: string): Promise<string | undefined> =>
  await Promise.resolve(key === 'home' ? s.business : undefined);

/** Work that settled one call at 100 and holds another unknown, its hold kept by the sweep. */
const kept = async (title: string): Promise<{ work: Work; runId: string }> => {
  const work = await liveWork(s, title, 2_000);
  const runId = await runOf(work);
  world.provider.mode('answer');
  expect(await call(work)).toMatchObject({ ok: true, actualMinor: 100 });
  world.provider.mode('costly');
  expect(await call(work)).toMatchObject({ ok: false, code: 'LIABILITY_UNKNOWN' });
  await s.db.admin.execute(
    `update public.leases set expires_at = clock_timestamp() where id = $1`,
    [work.picked['leaseId']],
  );
  expect(await sweepDeployment(s.db.app, resolve, ['home'])).toMatchObject({ ok: true });
  // Setup: the sweep kept the whole hold for a person.
  expect(await moneyOf(runId)).toMatchObject({ reservation: 'held', envelope_held: '2000' });
  return { work, runId };
};

it('B1: nothing happened on a kept hold settles the settled call and re-holds only the rest', async () => {
  const { work, runId } = await kept('pf3a sec b1');
  appliedDetail(
    await asPerson(s, {
      command: 'budget.record_outcome',
      operationId: randomUUID(),
      recordId: work.taskId,
      attemptId: work.decision['attemptId'],
      outcome: 'nothing_happened',
    }),
    'budget.record_outcome',
  );

  const after = await moneyOf(runId);
  expect(
    { actual: after.envelope_actual, held: after.envelope_held },
    'the 100 settled stays spent and only the 1900 left is held again',
  ).toEqual({ actual: '100', held: '1900' });
});

it('B1: a write-off of nothing on a kept hold still counts the settled call', async () => {
  const { work, runId } = await kept('pf3a sec b1 write-off');
  appliedDetail(
    await asPerson(s, {
      command: 'budget.write_off',
      operationId: randomUUID(),
      recordId: work.taskId,
      attemptId: work.decision['attemptId'],
      amountMinor: 0,
      reason: 'The provider shows no charge for the held call.',
    }),
    'budget.write_off',
  );

  const after = await moneyOf(runId);
  expect(
    { reservation: after.reservation, actual: after.envelope_actual, held: after.envelope_held },
    'the 100 settled stays spent',
  ).toEqual({ reservation: 'actual', actual: '100', held: '0' });
});
