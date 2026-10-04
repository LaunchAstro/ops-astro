// SPDX-License-Identifier: AGPL-3.0-only
//
// Review proof (SL12-18, MP-6-2 placement): a run's log rows keep the plan it
// was proposed under when a later plan is accepted on its successor's gate.
// `placeEvents` checks "a run of a plan's lineage" before the record bound at
// proposal, with no time order, so a later accept on the same lineage moves
// rows already drawn from JOB-01 of the first plan to "The plan".

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import {
  appliedDetail,
  approve,
  asAgent,
  createTask,
  handbackBody,
  pickup,
} from '../runtime/schedules-harness.ts';
import {
  acceptPlanOn,
  noDatabase,
  proposeStep,
  readAs,
  useAw06World,
  w,
} from '../runtime/aw-06-world.ts';
import { acceptAs, acceptRequest } from '../runtime/aw-04-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useAw06World('sl1218place');

interface Placed {
  readonly events: readonly { readonly runId: string; readonly placement: unknown }[];
}

async function placedAs(taskId: string): Promise<Placed> {
  const answer = (await readAs(w.s.decider, taskId)) as { readonly execution?: Placed };
  if (answer.execution === undefined) throw new Error(`no execution: ${JSON.stringify(answer)}`);
  return answer.execution;
}

it('a later plan accepted on a work run’s successor leaves that run’s rows in the plan it was proposed under', async () => {
  const taskId = await createTask(w.s, `sl1218-place-${randomUUID()}`);
  const first = await acceptPlanOn(taskId);
  const proposal = appliedDetail(
    await proposeStep(taskId, { kind: 'synthetic_comment', payload: {}, planStep: 'draft' }),
    'propose under draft',
  );
  const picked = await pickup(w.s, (await approve(w.s, proposal))['reservationId']);
  const placed = {
    runId: proposal['runId'],
    placement: { planRecordId: first.planRecordId, stepKey: 'draft', planRun: false },
  };
  expect((await placedAs(taskId)).events).toMatchObject([placed]);

  // The work run hands back asking for a successor on its own lineage; a
  // person then accepts a new plan on that successor's gate.
  const handed = appliedDetail(
    await asAgent(
      w.s,
      handbackBody(picked, {
        purpose: 'draft_the_reply',
        maximumMinor: 200,
        currency: 'AUD',
        payload: { instruction: 'a second pass' },
        step: { kind: 'synthetic_comment', payload: {} },
      }),
      String(picked['credential']),
    ),
    'task.handback',
  );
  const accepted = await acceptAs(
    w.s,
    acceptRequest(w.s, {
      taskId,
      proposal: { gateId: handed['successorGateId'], versionId: handed['successorVersionId'] },
    }),
  );
  if (!accepted.ok) throw new Error(`accept refused ${accepted.refusal.code}`);

  // The rows the log already drew for the work run do not move.
  const after = await placedAs(taskId);
  expect(after.events.filter((event) => event.runId === proposal['runId'])).toMatchObject([
    placed,
    placed,
  ]);
});
