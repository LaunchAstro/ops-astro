// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-BATCH-2 batch 3a, defect 7: a budget answer applies to an ask the
// person never saw. core-runtime's budget-answer-facts.ts finds the run's
// latest ask, and run.top_up / run.end_at_budget_stop (core-commands
// run-answers.ts) take no askId. A person looking at the first stop answers
// after the run has been topped up, picked up and stopped again: their answer
// lands on the second stop, with money and approvals they never saw.
//
// The fix names the ask: both commands take the askId the person was shown,
// and an answer to an ask that is no longer the open one is refused with
// nothing moved. This test sends the askId as the fix will require. On
// 3338f1fd6 the commands refuse any askId as an undescribed body field, so
// the case fails on that refusal; once the operand exists it must refuse the
// stale ask, and the current ask must still be answerable.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeCommand, isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import { topUpAtBudgetStop } from '../../packages/core-runtime/src/index.ts';
import type { Member } from '../commands/fixture.ts';
import { liveWork, pickup, type Work } from '../runtime/schedules-harness.ts';
import { call, noDatabase, s, useBrokerWorld, world } from './broker-world.ts';
import { as, moneyOf, one, people, setThreshold, usePeople } from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

/** Exactly the replay operation's priced maximum: one call fits, and none after it. */
const ONE_CALL = 500;

useBrokerWorld('rv3a7');
usePeople();

const asks = async (runId: string) =>
  await s.db.admin.execute<{ id: string; ask_number: number }>(
    `select id, ask_number from public.budget_asks where run_id = $1 order by ask_number`,
    [runId],
  );

/** A person's command, as the API hands it to the envelope. */
const send = async (member: Member, body: Record<string, unknown>) =>
  await executeCommand(s.db.app, s.business, member.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);

const codeOf = (result: Awaited<ReturnType<typeof send>>): string =>
  isCommandRefusal(result) ? result.code : 'applied';

/**
 * A run stopped twice: stop 1 (ask 1) answered by a top-up below the band,
 * picked up again, and spent until it stops a second time (ask 2).
 */
async function stoppedTwice(): Promise<{
  work: Work;
  runId: string;
  askOne: string;
  askTwo: string;
}> {
  await setThreshold(500);
  const work = await liveWork(s, 'rv3a7 two stops', ONE_CALL);
  world.provider.mode('answer');
  // Stop 1: one call fits the 500 ceiling, the second stops.
  expect((await call(work)).ok).toBe(true);
  expect((await call(work)).ok).toBe(false);
  const { run_id: runId } = await one<{ run_id: string }>(
    `select run_id from public.leases where id = $1`,
    [work.picked['leaseId']],
  );
  const [askOne] = await asks(runId);
  expect(askOne).toBeDefined();

  // Ask 1 is answered: a top-up below the four-eyes band, then a fresh pickup.
  const topped = await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await topUpAtBudgetStop(tx, {
        ...as(people.approver, runId),
        amountMinor: 300,
        currency: 'AUD',
      }),
  );
  expect(topped).toMatchObject({ ok: true, value: { state: 'applied' } });
  const again: Work = { ...work, picked: await pickup(s, work.decision['reservationId']) };

  // Spend on the new lease until the run stops a second time (ask 2).
  for (let n = 0; n < 10; n += 1) {
    // Sequential: each call spends what the next one reads.
    // eslint-disable-next-line no-await-in-loop
    if ((await asks(runId)).length >= 2) break;
    // eslint-disable-next-line no-await-in-loop
    await call(again);
  }
  const [, askTwo] = await asks(runId);
  expect(askTwo, 'setup: the run stops a second time').toBeDefined();
  return { work, runId, askOne: String(askOne?.id), askTwo: String(askTwo?.id) };
}

it('REVIEW-3A-7: a top-up or an end sent against the first budget stop never applies to the second', async () => {
  const { work, runId, askOne, askTwo } = await stoppedTwice();
  const before = await moneyOf(runId);
  expect(before).toMatchObject({ run: 'waiting_budget', asks: 2 });

  // People who saw ask 1 answer it now: the approver tops up, a second holder ends.
  const staleTopUp = await send(people.approver, {
    command: 'run.top_up',
    recordId: work.taskId,
    runId,
    askId: askOne,
    amountMinor: 300,
    currency: 'AUD',
  });
  expect(
    codeOf(staleTopUp),
    'run.top_up must take the askId the person saw (today any askId is an undescribed field)',
  ).not.toBe('COMMAND_BODY_INVALID');
  expect(codeOf(staleTopUp), 'a top-up of ask 1 must not apply to ask 2').not.toBe('applied');
  expect(await moneyOf(runId)).toEqual(before);

  const staleEnd = await send(people.second, {
    command: 'run.end_at_budget_stop',
    recordId: work.taskId,
    runId,
    askId: askOne,
  });
  expect(codeOf(staleEnd), 'run.end_at_budget_stop must take the askId the person saw').not.toBe(
    'COMMAND_BODY_INVALID',
  );
  expect(codeOf(staleEnd), 'an end of ask 1 must not end the run at ask 2').not.toBe('applied');
  // Nothing moved on ask 2: no answer, no approval, no money.
  expect(await moneyOf(runId)).toEqual(before);

  // Ask 2, named by the person who sees it, is still answerable.
  const current = await send(people.approver, {
    command: 'run.top_up',
    recordId: work.taskId,
    runId,
    askId: askTwo,
    amountMinor: 300,
    currency: 'AUD',
  });
  expect(codeOf(current)).toBe('applied');
});
