// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-BATCH-2 #313, batch 3b, defect 2: accepting a plan leaves the gate's
// inbox decision items open. `task.propose` raises a decision item on the new
// gate for every person holding task:decide (`raiseDecision`,
// tasks-propose.ts), and `task.decide` clears them in the decision's own
// transaction (`clearDecision`, tasks-decide.ts, INB-1c). `task.accept_plan`
// approves the same gate (plan-accept.ts) but never calls `clearDecision`, so
// the decider is still owed an item on a gate that is already approved.
//
// The case: a plan proposed through the command path raises the decider's
// item, which `inbox.count` counts; the decider accepts it through
// `task.accept_plan`. The item must be cleared and the count must drop. On
// 5b241be67 the item stays open and the count stays where it was.

import { expect, it as vitestIt } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import {
  acceptBody,
  gateOf,
  noDatabase,
  proposed,
  useAw04World,
  useInstructionRoot,
  w,
} from './aw-04-world.ts';
import { appliedDetail, asPerson } from './schedules-harness.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useAw04World('rv3b2');
useInstructionRoot();

/** The decider's owed count, through the `inbox.count` read the API serves. */
async function owed(): Promise<number> {
  const answer = (await executeRead(w.alpha.db.app, w.alpha.business, w.alpha.decider.presented, {
    read: 'inbox.count',
  })) as unknown as { readonly ok?: boolean; readonly owed?: number };
  expect(answer.ok).toBe(true);
  return Number(answer.owed);
}

/** The gate's decision items, straight from the table as the owner reads them. */
async function itemsOn(gateId: unknown): Promise<readonly Record<string, unknown>[]> {
  return await w.alpha.db.admin.execute(
    `select recipient_person_id as recipient, work_state, closed_by_person_id as closed_by
       from public.inbox_items where fact_id = $1 and reason = 'decision'
      order by recipient_person_id`,
    [gateId],
  );
}

it("REVIEW-3B-2: task.accept_plan clears the gate's inbox decision items and inbox.count drops, as task.decide does", async () => {
  const plan = await proposed(w.alpha, 'review 3b-2 accept clears the inbox');
  const gateId = plan.proposal['gateId'];
  // The proposal raised the decider's decision item on the gate, and it is counted.
  const raised = await itemsOn(gateId);
  expect(raised.length).toBeGreaterThanOrEqual(1);
  expect(raised.map((item) => item['work_state'])).toStrictEqual(raised.map(() => 'open'));
  expect(raised.map((item) => item['recipient'])).toContain(w.alpha.decider.personId);
  const before = await owed();
  expect(before).toBeGreaterThanOrEqual(1);

  appliedDetail(await asPerson(w.alpha, acceptBody(plan)), 'task.accept_plan');
  expect(await gateOf(w.alpha, gateId)).toEqual({ state: 'approved', decisions: '1' });

  const after = await itemsOn(gateId);
  expect(
    after.map((item) => item['work_state']),
    "the accepted gate's decision items are still open: task.accept_plan never calls clearDecision",
  ).toStrictEqual(raised.map(() => 'cleared'));
  expect(after.map((item) => item['closed_by'])).toStrictEqual(
    raised.map(() => w.alpha.decider.personId),
  );
  expect(await owed(), 'inbox.count still owes the decider the accepted gate').toBe(before - 1);
});
