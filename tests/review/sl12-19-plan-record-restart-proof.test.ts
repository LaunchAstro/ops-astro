// SPDX-License-Identifier: AGPL-3.0-only
//
// Review proof (SL12-19, MP-6-2 stored plan record, 0223): `task.restart`
// proposes a new run through `propose` in core-runtime, which passes no
// `planRecordId`, so its step is written with `plan_record_written` false and
// the run is placed by time, the race 0223 closes. 0223 says only a row from
// before the migration holds false.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import {
  appliedDetail,
  asPerson,
  createTask,
  freshPurpose,
  propose,
  rows,
} from '../runtime/schedules-harness.ts';
import { acceptPlanOn, noDatabase, useAw06World, w } from '../runtime/aw-06-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useAw06World('sl1219restart');

it('MP-6-2 stored record: a run task.restart proposes stores the plan record bound at its proposal', async () => {
  const taskId = await createTask(w.s, `sl1219-restart-${randomUUID()}`);
  const plan = await acceptPlanOn(taskId);
  const work = await propose(w.s, taskId, { maximumMinor: 300, purpose: freshPurpose() });
  appliedDetail(
    await asPerson(w.s, {
      command: 'task.decide',
      operationId: randomUUID(),
      gateId: work['gateId'],
      versionId: work['versionId'],
      decision: 'reject',
      note: 'not this one',
    }),
    'task.decide reject',
  );
  const restarted = appliedDetail(
    await asPerson(w.s, {
      command: 'task.restart',
      operationId: randomUUID(),
      recordId: taskId,
      lineageId: work['lineageId'],
    }),
    'task.restart',
  );

  const steps = await rows<{
    readonly plan_record_id: string | null;
    readonly plan_record_written: boolean;
  }>(
    w.s,
    `select st.plan_record_id, st.plan_record_written
       from public.planned_steps st
       join public.planned_runs run on run.business_id = st.business_id and run.id = st.run_id
      where run.version_id = $1 and st.ordinal = 1`,
    [restarted['versionId']],
  );
  expect(steps).toEqual([{ plan_record_id: plan.planRecordId, plan_record_written: true }]);
});
