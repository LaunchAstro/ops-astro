// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function -- Sol's proof body, committed unchanged */
import { expect, it } from 'vitest';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { dispatch } from '../../packages/core-runtime/src/dispatch.ts';
import { useAw06World, w } from './aw-06-world.ts';
import { leased, marked } from './aw-08-gate-world.ts';
import { barrier, racer, rows } from './schedules-harness.ts';

useAw06World('sol_ow050_signoff');

it('Sol proof, criterion 5: first sign-off setting write cannot commit between dispatch check and marker', async () => {
  const owner = w.s;
  const work = await leased(owner, 'launch', 'Sol first sign-off setting');
  expect(
    await rows(
      owner,
      `select id from public.business_settings
    where business_id = $1 and key = 'client_sign_off_required'`,
      [owner.business],
    ),
  ).toEqual([]);
  const rival = racer(owner);
  const checked = barrier();
  const continueDispatch = barrier();
  const dispatching = owner.db.app.withBusiness(owner.business, async (tx) => {
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
    // The real reader is paused after its check; a writer must wait for its transaction.
    await Promise.race([
      setting,
      new Promise((resolve) => {
        setTimeout(resolve, 5000);
      }),
    ]);
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
