// SPDX-License-Identifier: AGPL-3.0-only
//
// PLANFIX-3A settle, security finding B3: a hold that spent on model calls
// now closes `actual`, and pickup replaced only an `abandoned` one, so a run
// whose hold a restart replay or an expired lease's pickup closed `actual`
// could never be picked up again. Pickup replaces it, holding only what the
// old hold had not spent.

import { expect, it as vitestIt } from 'vitest';
import { recoverDeployment } from '../../apps/api/recovery-entry.ts';
import { liveWork, pickup, type Work } from '../runtime/schedules-harness.ts';
import { call, noDatabase, s, useBrokerWorld, world } from './broker-world.ts';
import { moneyOf, one } from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('pf3asecb3');

const runOf = async (work: Work): Promise<string> =>
  (
    await one<{ run_id: string }>(`select run_id from public.leases where id = $1`, [
      work.picked['leaseId'],
    ])
  ).run_id;

const resolve = async (key: string): Promise<string | undefined> =>
  await Promise.resolve(key === 'home' ? s.business : undefined);

/** Live work that spent 100 on one settled model call out of its 2000 hold. */
const spent = async (title: string): Promise<{ work: Work; runId: string }> => {
  const work = await liveWork(s, title, 2_000);
  world.provider.mode('answer');
  expect(await call(work)).toMatchObject({ ok: true, actualMinor: 100 });
  return { work, runId: await runOf(work) };
};

it('B3: a hold a restart replay closed actual is picked up again on what it has left', async () => {
  const { work, runId } = await spent('pf3a sec b3 replay');
  // A lease fenced and never classified: the restart replay's case.
  await s.db.admin.execute(
    `update public.leases set state = 'expired', released_at = clock_timestamp() where id = $1`,
    [work.picked['leaseId']],
  );
  expect(await recoverDeployment(s.db.app, resolve, ['home'])).toMatchObject({ ok: true });
  // Setup: the replay settled the hold at the call's 100.
  expect(await moneyOf(runId)).toMatchObject({ reservation: 'actual', envelope_actual: '100' });

  await pickup(s, work.decision['reservationId']);

  expect(await moneyOf(runId)).toMatchObject({
    reservation: 'held',
    held: '1900',
    envelope_held: '1900',
    envelope_actual: '100',
  });
});

it('B3: an expired lease on a spent hold is picked up again on what it has left', async () => {
  const { work, runId } = await spent('pf3a sec b3 expired');
  await s.db.admin.execute(
    `update public.leases set expires_at = clock_timestamp() where id = $1`,
    [work.picked['leaseId']],
  );

  await pickup(s, work.decision['reservationId']);

  expect(await moneyOf(runId)).toMatchObject({
    reservation: 'held',
    held: '1900',
    envelope_held: '1900',
    envelope_actual: '100',
  });
});
