// SPDX-License-Identifier: AGPL-3.0-only
//
// SEC P3 r2 L1: a person's own lease stops at its ceiling, and that person
// then observes the applied step with a priced cost. The cost and the calls
// come to more than the hold, so observation keeps the hold whole for a
// person's outcome (`settleAtObserved`, #832). The step's cost is counted
// nowhere yet, so ending the run must not release the hold less only its
// calls: that would hand the step's cost back to the cap as unspent and leave
// the attempt held on a hold that no longer exists. The end is refused with
// nothing moved, and the person's recorded outcome still answers the hold.
//
// SEC P3 r3 N4: once that outcome says the step happened, the step is
// finished. A top-up would hold it afresh and run it again, so it is refused
// with nothing written, and the end still answers the stop.
//
// SEC P3 r4 R1: the same holds when the outcome's transaction began before
// the stop raised its ask (a person's `happened` that waited on the run's lock
// while the worker's call stopped the run), so its start time comes first.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeCommand, isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { asPerson, codeOf, racer } from '../runtime/schedules-harness.ts';
import { PRICED } from '../runtime/t2d-harness.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { moneyOf, one, people, setThreshold, usePeople } from './budget-answers-world.ts';
import {
  answer,
  appliedWithOneCall,
  holdsOf,
  observeOver,
  ONE_CALL,
  stateOf,
  stopIt,
  stoppedAfterItsEffect,
} from './observed-hold-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('endobserved');
usePeople();

it('an end after an observation kept the hold whole is refused, and the hold waits for a person', async () => {
  const { w, lease, runId, askId } = await stoppedAfterItsEffect();

  // The person observes after the stop: cost and calls are above the hold, so it is kept whole.
  const observed = await asPerson(s, {
    command: 'task.observe',
    operationId: randomUUID(),
    ...lease,
    attemptId: w.attemptId,
    usage: PRICED,
  });
  expect(codeOf(observed)).toBe('BUDGET_UNAVAILABLE');
  const before = await stateOf(runId, w.attemptId);
  expect(before).toMatchObject({
    run: 'waiting_budget',
    reservation: 'held',
    attempt: 'liability_unknown',
  });

  const ended = await executeCommand(s.db.app, s.business, people.second.presented, 'api', {
    command: 'run.end_at_budget_stop',
    operationId: randomUUID(),
    recordId: w.taskId,
    runId,
    askId,
  } as never);

  expect(isCommandRefusal(ended) ? ended.code : 'applied').toBe('TRANSITION_NOT_PERMITTED');
  expect(await stateOf(runId, w.attemptId)).toEqual(before);

  // A person's outcome answers the hold: it is spent whole, never handed back as unspent.
  const recorded = await asPerson(s, {
    command: 'budget.record_outcome',
    operationId: randomUUID(),
    recordId: w.taskId,
    attemptId: w.attemptId,
    outcome: 'happened',
  });
  expect(codeOf(recorded)).toBe('applied');
  expect(await stateOf(runId, w.attemptId)).toMatchObject({
    reservation: 'actual',
    envelope_actual: String(Number(before.envelope_actual) + ONE_CALL),
  });
});

it('a top-up after the stopped step was recorded as happened is refused, and the end still applies', async () => {
  await setThreshold(null);
  const { w, lease, runId, askId } = await stoppedAfterItsEffect();
  expect(await observeOver(w, lease)).toBe('BUDGET_UNAVAILABLE');
  const recorded = await asPerson(s, {
    command: 'budget.record_outcome',
    operationId: randomUUID(),
    recordId: w.taskId,
    attemptId: w.attemptId,
    outcome: 'happened',
  });
  expect(codeOf(recorded)).toBe('applied');
  const before = { ...(await stateOf(runId, w.attemptId)), holds: await holdsOf(runId) };
  expect(before).toMatchObject({ run: 'waiting_budget', reservation: 'actual', answers: 0 });

  const ask = { recordId: w.taskId, runId, askId };
  const topUp = { command: 'run.top_up', ...ask, amountMinor: 1_000, currency: 'AUD' };
  expect(await answer(people.approver, topUp)).toBe('TRANSITION_NOT_PERMITTED');
  // Nothing written: no answer, no approval, no fresh hold for the finished step, the run waiting.
  expect({ ...(await stateOf(runId, w.attemptId)), holds: await holdsOf(runId) }).toEqual(before);

  expect(await answer(people.second, { command: 'run.end_at_budget_stop', ...ask })).toBe(
    'applied',
  );
  expect(await moneyOf(runId)).toMatchObject({ run: 'cancelled', answers: 1 });
});

/** A `happened` through the command entry, in a transaction on its own connection begun before `stop`. */
async function happenedBegunBefore<T>(
  w: { taskId: string; attemptId: string },
  stop: () => Promise<T>,
) {
  const held = racer(s);
  try {
    return await held.withBusiness(s.business, async (tx) => {
      const [now] = await tx.query<{ began: Date }>('select now() as began');
      const stopped = await stop();
      const body = {
        command: 'budget.record_outcome',
        operationId: randomUUID(),
        recordId: w.taskId,
      };
      const inTx = { ...held, withBusiness: async (_b, run) => await run(tx) } as Database;
      const recorded = await asPerson(
        s,
        { ...body, attemptId: w.attemptId, outcome: 'happened' },
        inTx,
      );
      return { ...stopped, began: now?.began, code: codeOf(recorded) };
    });
  } finally {
    await held.close();
  }
}

it('a top-up is refused when the happened was recorded in a transaction begun before the stop', async () => {
  await setThreshold(null);
  const { w, lease } = await appliedWithOneCall();
  // Observed before the stop: the hold is kept whole, and the lease stays live for the next call.
  expect(await observeOver(w, lease)).toBe('BUDGET_UNAVAILABLE');
  const recorded = await happenedBegunBefore(w, async () => await stopIt(w, lease));
  expect(recorded.code).toBe('applied');
  const { runId, askId } = recorded;
  const ask = { recordId: w.taskId, runId, askId };
  const { raised } = await one<{ raised: Date }>(
    `select raised_at as raised from public.budget_asks where id = $1`,
    [askId],
  );
  expect(recorded.began?.getTime()).toBeLessThan(raised.getTime());
  const before = { ...(await stateOf(runId, w.attemptId)), holds: await holdsOf(runId) };
  expect(before).toMatchObject({ run: 'waiting_budget', reservation: 'actual', answers: 0 });
  const topUp = { command: 'run.top_up', ...ask, amountMinor: 1_000, currency: 'AUD' };
  expect(await answer(people.approver, topUp)).toBe('TRANSITION_NOT_PERMITTED');
  expect({ ...(await stateOf(runId, w.attemptId)), holds: await holdsOf(runId) }).toEqual(before);
  const end = { command: 'run.end_at_budget_stop', ...ask };
  expect(await answer(people.second, end)).toBe('applied');
  expect(await moneyOf(runId)).toMatchObject({ run: 'cancelled', answers: 1 });
});
