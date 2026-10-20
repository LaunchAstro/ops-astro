// SPDX-License-Identifier: AGPL-3.0-only
//
// A run stopped at its ceiling waits on one ask (AW-05). Its stopped step's
// cost ran above the hold, so the end is refused until a person records the
// step's outcome (`observedRefusal`). When that outcome is `nothing_happened`
// and the step's one call had spent the whole hold, the step resumes with
// nothing left to hold, which is a stop at a spent hold (`stopAtSpentHold`).
// The run already waits for a person, so that stop raises no second ask: the
// run keeps its one ask, and the person's answer to it still ends the run.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { asPerson, codeOf } from '../runtime/schedules-harness.ts';
import { PRICED } from '../runtime/t2d-harness.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { moneyOf, one, people, usePeople } from './budget-answers-world.ts';
import { answer, dispatchedWithOneCall, stateOf, stopIt } from './observed-hold-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('outcomewaiting');
usePeople();

it("an outcome that leaves a waiting run's step nothing to hold raises no second ask", async () => {
  const { w, lease } = await dispatchedWithOneCall(false);
  // A provider billing the whole maximum: the replay never answers that high, so the settled
  // call's row is moved as the broker's settle moves it.
  await one(
    `update public.model_calls set observed_minor = reserved_minor, actual_minor = reserved_minor
      where lease_id = $1 and state = 'settled' returning id`,
    [lease.leaseId],
  );
  const { runId, askId } = await stopIt(w, lease);
  const observed = await asPerson(s, {
    command: 'task.observe',
    operationId: randomUUID(),
    ...lease,
    attemptId: w.attemptId,
    outcome: 'failed',
    usage: PRICED,
  });
  expect(codeOf(observed)).toBe('BUDGET_UNAVAILABLE');
  expect(await stateOf(runId, w.attemptId)).toMatchObject({
    run: 'waiting_budget',
    reservation: 'held',
    attempt: 'liability_unknown',
    asks: 1,
  });

  const recorded = await asPerson(s, {
    command: 'budget.record_outcome',
    operationId: randomUUID(),
    recordId: w.taskId,
    attemptId: w.attemptId,
    outcome: 'nothing_happened',
  });
  expect(codeOf(recorded)).toBe('applied');
  expect(await moneyOf(runId)).toMatchObject({ run: 'waiting_budget', asks: 1 });

  const end = { command: 'run.end_at_budget_stop', recordId: w.taskId, runId, askId };
  expect(await answer(people.second, end)).toBe('applied');
  expect(await moneyOf(runId)).toMatchObject({ run: 'cancelled', asks: 1, answers: 1 });
});
