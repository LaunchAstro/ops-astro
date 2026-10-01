// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-2's placement against a real database, with the plan record stored at
// proposal (0223, ORCH49). The race the time order could not see: an accept
// that began before a proposal parks on the decision-chain lock (the first
// lock `decide` takes, before the task), the proposal commits, and then the
// accept binds its record with a `bound_at` earlier than the run's
// `created_at`. The run stays in the plan the proposal checked its key
// against, or in none.
//
// The column's security line is `mp-6-2-plan-record-isolation.test.ts`.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { acquire, boundPlanOf } from '../../packages/core-runtime/src/index.ts';
import type { PlanAcceptRequest } from '../../packages/core-runtime/src/index.ts';
import {
  appliedDetail,
  approve,
  asPerson,
  awaitParked,
  createTask,
  freshPurpose,
  pickup,
  propose,
  racer,
  rows,
  type Detail,
} from './schedules-harness.ts';
import {
  acceptPlanOn,
  graphAs,
  noDatabase,
  proposeStep,
  readAs,
  useAw06World,
  w,
} from './aw-06-world.ts';
import { acceptAs, acceptRequest, PLAN, PLAN_TEXT } from './aw-04-world.ts';
import { FILES, sourceOf } from './aw-02-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useAw06World('mp62stored');

interface Placed {
  readonly events: readonly { readonly runId: string; readonly placement: unknown }[];
  readonly plans: readonly { readonly planRecordId: string }[];
}

async function placedAs(taskId: string): Promise<Placed> {
  const answer = (await readAs(w.s.decider, taskId)) as { readonly execution?: Placed };
  if (answer.execution === undefined) throw new Error(`no execution: ${JSON.stringify(answer)}`);
  return answer.execution;
}

/** A plan proposed on `taskId`, and the accept the decider would send for it. */
async function planToAccept(taskId: string): Promise<PlanAcceptRequest> {
  const proposal = await propose(w.s, taskId, { maximumMinor: 500, purpose: freshPurpose() });
  const plan = boundPlanOf(PLAN_TEXT, PLAN);
  if ('field' in plan) throw new Error(plan.reason);
  return { ...acceptRequest(w.s, { taskId, proposal }), plan };
}

/**
 * `accept` begun first and parked on the business's decision chain while
 * `proposeIt` commits, then let go: the proposal took the task lock first,
 * the accept's clock is the earlier one. The proposal and the bound record.
 */
async function acceptBehind(
  accept: PlanAcceptRequest,
  proposeIt: () => Promise<Detail>,
): Promise<{ readonly proposal: Detail; readonly planRecordId: string }> {
  const holder = racer(w.s);
  const accepting = racer(w.s);
  let letGo!: () => void;
  const gate = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const held = holder.withBusiness(w.s.business, async (tx) => {
    await acquire(tx, [{ lockClass: 'chain', id: 'gate_decisions' }]);
    locked();
    await gate;
  });
  try {
    await isLocked;
    const accepted = acceptAs(w.s, accept, sourceOf(FILES), accepting);
    await awaitParked(w.s, 'advisory', 1);
    const proposal = await proposeIt();
    letGo();
    await held;
    const bound = await accepted;
    if (!bound.ok) throw new Error(`accept refused ${bound.refusal.code}`);
    return { proposal, planRecordId: bound.value.planRecordId };
  } finally {
    letGo();
    await held.catch(() => null);
    await holder.close();
    await accepting.close();
  }
}

/** The schedule is the race: the record's clock reads before the run's. */
async function boundBeforeProposed(planRecordId: string, runId: unknown): Promise<boolean> {
  const [row] = await rows<{ readonly earlier: boolean }>(
    w.s,
    `select pr.bound_at < run.created_at as earlier
       from public.plan_records pr, public.planned_runs run
      where pr.id = $1 and run.id = $2`,
    [planRecordId, runId],
  );
  return row?.earlier === true;
}

/** Room on the task's open envelope for the work run, raised by the decider (T2e). */
async function topUp(taskId: string): Promise<void> {
  const [envelope] = await rows<{ readonly maximum: string }>(
    w.s,
    `select maximum_minor::text as maximum from public.task_envelopes
      where task_id = $1 and state = 'open'`,
    [taskId],
  );
  appliedDetail(
    await asPerson(w.s, {
      command: 'budget.top_up',
      operationId: randomUUID(),
      recordId: taskId,
      amountMinor: 50_000,
      fromMaximumMinor: Number(envelope?.maximum),
    }),
    'budget.top_up',
  );
}

it('MP-6-2 placement reads the plan record stored at proposal: an accept begun before a proposal and bound after it relabels no row', async () => {
  const taskId = await createTask(w.s, `mp62-stored-${randomUUID()}`);
  const first = await acceptPlanOn(taskId);
  const { proposal, planRecordId: second } = await acceptBehind(
    await planToAccept(taskId),
    async () =>
      appliedDetail(
        await proposeStep(taskId, { kind: 'synthetic_comment', payload: {}, planStep: 'draft' }),
        'propose under draft',
      ),
  );
  expect(await boundBeforeProposed(second, proposal['runId'])).toBe(true);
  expect((await graphAs(w.s.decider, taskId)).planRecordId).toBe(second);
  await pickup(w.s, (await approve(w.s, proposal))['reservationId']);

  expect((await placedAs(taskId)).events).toMatchObject([
    {
      runId: proposal['runId'],
      placement: { planRecordId: first.planRecordId, stepKey: 'draft', planRun: false },
    },
  ]);
});

it('MP-6-2 placement reads the plan record stored at proposal: a run proposed under no plan stays under none when the first accept binds after it', async () => {
  const taskId = await createTask(w.s, `mp62-stored-none-${randomUUID()}`);
  const { proposal, planRecordId } = await acceptBehind(await planToAccept(taskId), async () =>
    appliedDetail(
      await proposeStep(taskId, { kind: 'synthetic_comment', payload: {} }),
      'propose under no plan',
    ),
  );
  expect(await boundBeforeProposed(planRecordId, proposal['runId'])).toBe(true);
  await topUp(taskId);
  await pickup(w.s, (await approve(w.s, proposal))['reservationId']);

  const placed = await placedAs(taskId);
  expect(placed.events).toMatchObject([
    { runId: proposal['runId'], placement: { planRecordId: null, stepKey: null, planRun: false } },
  ]);
  expect(placed.plans).toEqual([]);
});
