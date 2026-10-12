// SPDX-License-Identifier: AGPL-3.0-only
//
// The end of a budget-stopped run reaches a trashed task, and it is refused
// while the stopped step's cost is unresolved (`observedRefusal`): a person
// records the step's outcome first. `budget.record_outcome` does not reach a
// trashed task, so on one the refusal names the restore first, and following
// it (restore, record the outcome, end) answers the hold. Nothing moves on the
// refusal.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { appliedDetail, asPerson, codeOf, revisionOf } from '../runtime/schedules-harness.ts';
import { PRICED } from '../runtime/t2d-harness.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { moneyOf, people, usePeople } from './budget-answers-world.ts';
import { answer, answerOf, dispatchedWithOneCall, stateOf, stopIt } from './observed-hold-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('endtrashedrestore');
usePeople();

const outcome = async (w: { taskId: string; attemptId: string }) =>
  codeOf(
    await asPerson(s, {
      command: 'budget.record_outcome',
      operationId: randomUUID(),
      recordId: w.taskId,
      attemptId: w.attemptId,
      outcome: 'happened',
    }),
  );

it('an end refused for an unresolved cost on a trashed task names the restore, and following it ends the run', async () => {
  const { w, lease } = await dispatchedWithOneCall(false);
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
  const trashed = appliedDetail(
    await asPerson(s, {
      command: 'task.trash',
      operationId: randomUUID(),
      recordId: w.taskId,
      expectedRevision: await revisionOf(s, w.taskId),
    }),
    'task.trash',
  );
  const before = await stateOf(runId, w.attemptId);
  expect(before).toMatchObject({ run: 'waiting_budget', attempt: 'liability_unknown' });

  const end = { command: 'run.end_at_budget_stop', recordId: w.taskId, runId, askId };
  const refused = await answerOf(people.second, end);
  expect(refused).toMatchObject({ code: 'TRANSITION_NOT_PERMITTED' });
  if (refused === 'applied') throw new Error('the end applied with the cost unresolved');
  expect(refused.fixes.join(' ')).toContain('Restore the task from the trash');
  expect(await stateOf(runId, w.attemptId)).toEqual(before);
  // Why the restore comes first: the outcome does not reach a task in the trash.
  expect(await outcome(w)).toBe('NOT_FOUND');

  const restored = await asPerson(s, {
    command: 'task.restore',
    operationId: randomUUID(),
    batchId: trashed['batchId'],
  });
  expect(codeOf(restored)).toBe('applied');
  expect(await outcome(w)).toBe('applied');
  expect(await answer(people.second, end)).toBe('applied');
  expect(await moneyOf(runId)).toMatchObject({ run: 'cancelled', answers: 1 });
});
