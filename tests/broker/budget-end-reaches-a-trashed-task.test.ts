// SPDX-License-Identifier: AGPL-3.0-only
//
// A run stopped at its ceiling on a task that is then trashed still holds its
// budget. Ending it is how a person gives that budget back, so the end reaches
// a trashed task: the hold is released and the envelope's held count drops.
// Raising the budget of a trashed task is refused, with nothing moved.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeCommand, isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import { topUpAtBudgetStop } from '../../packages/core-runtime/src/index.ts';
import { appliedDetail, asPerson, revisionOf } from '../runtime/schedules-harness.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import {
  as,
  moneyOf,
  one,
  people,
  setThreshold,
  stopped,
  UNDER_ONE_CALL,
  usePeople,
} from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('endtrashed');
usePeople();

const trash = async (taskId: string): Promise<void> => {
  const trashed = await asPerson(s, {
    command: 'task.trash',
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revisionOf(s, taskId),
  });
  appliedDetail(trashed, 'task.trash');
};

it('ending a budget-stopped run on a trashed task releases its hold', async () => {
  await setThreshold(500);
  const { work, runId, askId } = await stopped('end on a trashed task');
  await trash(work.taskId);
  const before = await moneyOf(runId);
  expect(before).toMatchObject({ run: 'waiting_budget', reservation: 'held' });

  const topped = await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await topUpAtBudgetStop(tx, {
        ...as(people.approver, runId),
        amountMinor: 300,
        currency: 'AUD',
      }),
  );
  expect(topped, 'a trashed task takes no top-up').toMatchObject({
    ok: false,
    refusal: { code: 'NOT_FOUND' },
  });
  expect(await moneyOf(runId)).toEqual(before);

  const ended = await executeCommand(s.db.app, s.business, people.second.presented, 'api', {
    command: 'run.end_at_budget_stop',
    operationId: randomUUID(),
    recordId: work.taskId,
    runId,
    askId,
  } as never);
  expect(isCommandRefusal(ended) ? ended.code : 'applied').toBe('applied');
  expect(await moneyOf(runId)).toMatchObject({
    run: 'cancelled',
    reservation: 'abandoned',
    envelope_held: String(Number(before.envelope_held) - UNDER_ONE_CALL),
    envelope_actual: before.envelope_actual,
    cap_committed: String(Number(before.cap_committed) - UNDER_ONE_CALL),
    answers: 1,
  });
  const { cause } = await one<{ cause: string }>(
    `select classified_cause as cause from public.reservations where run_id = $1`,
    [runId],
  );
  expect(cause).toBe('budget_stop_ended');
});
