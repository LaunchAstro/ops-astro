// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-2's operational log, against a real database: `task.execution` places
// each event in the plan its run was proposed under (`execution-placement.ts`),
// so a re-plan moves the graph to the newer record and leaves the log's rows
// where they were. The plans are accepted by the production accept, the run
// proposed and picked up through the production command entry, and every read
// goes through the production read entry.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { appliedDetail, approve, createTask, pickup } from './schedules-harness.ts';
import {
  acceptPlanOn,
  graphAs,
  noDatabase,
  proposeStep,
  readAs,
  useAw06World,
  w,
} from './aw-06-world.ts';
import { PLAN } from './aw-04-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useAw06World('mp62place');

interface Placed {
  readonly events: readonly { readonly runId: string; readonly placement: unknown }[];
  readonly plans: readonly { readonly planRecordId: string; readonly steps: unknown }[];
}

/** `task.execution`'s events with their placements, and the plans they name. */
async function placedAs(taskId: string): Promise<Placed> {
  const answer = (await readAs(w.s.decider, taskId)) as { readonly execution?: Placed };
  if (answer.execution === undefined) throw new Error(`no execution: ${JSON.stringify(answer)}`);
  return answer.execution;
}

it('MP-6-2 placement: a run’s events stay in the plan it was proposed under when a newer plan is bound', async () => {
  const taskId = await createTask(w.s, `mp62-place-${randomUUID()}`);
  const first = await acceptPlanOn(taskId);
  const proposal = appliedDetail(
    await proposeStep(taskId, { kind: 'synthetic_comment', payload: {}, planStep: 'draft' }),
    'propose under draft',
  );
  await pickup(w.s, (await approve(w.s, proposal))['reservationId']);
  const placed = {
    runId: proposal['runId'],
    placement: { planRecordId: first.planRecordId, stepKey: 'draft', planRun: false },
  };
  const firstSteps = PLAN.steps.map(({ key, title }) => ({ key, title }));

  const before = await placedAs(taskId);
  expect(before.events).toMatchObject([placed]);
  expect(before.plans).toEqual([{ planRecordId: first.planRecordId, steps: firstSteps }]);

  // Re-planned with the same key under another title: the graph moves to the
  // new record, the event stays in the plan it was proposed under.
  const second = await acceptPlanOn(taskId, {
    steps: [{ key: 'draft', title: 'Draft it again', after: [] }],
  });
  expect((await graphAs(w.s.decider, taskId)).planRecordId).toBe(second.planRecordId);
  const after = await placedAs(taskId);
  expect(after.events).toMatchObject([placed]);
  expect(after.plans.find((plan) => plan.planRecordId === first.planRecordId)?.steps).toEqual(
    firstSteps,
  );
});
