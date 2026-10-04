// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { dispatch } from '../../packages/core-runtime/src/dispatch.ts';
import { useAw06World, w } from './aw-06-world.ts';
import { leased, marked, type Leased } from './aw-08-gate-world.ts';
import { awaitParked, barrier, racer, rows, type Schedules } from './schedules-harness.ts';

useAw06World('sol_ow050_signoff');

type Barrier = ReturnType<typeof barrier>;

/** The business starts with no sign-off setting row: nothing for the reader to lock. */
async function expectNoSignOffRow(owner: Schedules): Promise<void> {
  expect(
    await rows(
      owner,
      `select id from public.business_settings
    where business_id = $1 and key = 'client_sign_off_required'`,
      [owner.business],
    ),
  ).toEqual([]);
}

/** Dispatch, paused after its sign-off setting read until `continueDispatch` is released. */
function dispatchPausedAfterCheck(
  owner: Schedules,
  work: Leased,
  checked: Barrier,
  continueDispatch: Barrier,
) {
  return owner.db.app.withBusiness(owner.business, async (tx) => {
    const paused: TenantQuery = {
      businessId: tx.businessId,
      async query<Row>(sql: string, parameters?: readonly unknown[]): Promise<readonly Row[]> {
        const answer = await tx.query<Row>(sql, parameters);
        if (sql.includes('select value from public.business_settings')) {
          checked.release();
          await continueDispatch.held;
        }
        return answer;
      },
    };
    return await dispatch(paused, {
      claimant: 'agent',
      collection: 'task',
      holderActorId: owner.agentActorId,
      delegationId: String(work.picked['delegationId']),
      leaseId: String(work.picked['leaseId']),
      fence: Number(work.picked['fence']),
    });
  });
}

it('first sign-off setting write cannot commit between dispatch check and marker', async () => {
  const owner = w.s;
  const work = await leased(owner, 'launch', 'Sol first sign-off setting');
  await expectNoSignOffRow(owner);
  const rival = racer(owner);
  const checked = barrier();
  const continueDispatch = barrier();
  const dispatching = dispatchPausedAfterCheck(owner, work, checked, continueDispatch);
  await checked.held;
  let committedBeforeMarker = false;
  const setting = rival
    .withBusiness(owner.business, async (tx) => {
      await installBusinessSettings(tx);
      await tx.query(
        `update public.business_settings set value = 'true'::jsonb
      where business_id = $1 and key = 'client_sign_off_required'`,
        [tx.businessId],
      );
    })
    .then(() => {
      committedBeforeMarker = true;
      return true;
    });
  try {
    // The real reader is paused after its check; the writer is seen waiting on
    // the server for the reader's lock before dispatch goes on.
    await awaitParked(owner, 'advisory', 1);
    const crossedTheCheck = committedBeforeMarker;
    continueDispatch.release();
    const answer = await dispatching;
    await setting;
    expect({ crossedTheCheck, marked: await marked(owner, work.taskId) }).not.toEqual({
      crossedTheCheck: true,
      marked: 1,
    });
    expect(answer.ok || answer.refusal.code === 'CLIENT_SIGNOFF_REQUIRED').toBe(true);
  } finally {
    continueDispatch.release();
    await dispatching;
    await setting;
    await rival.close();
  }
});
