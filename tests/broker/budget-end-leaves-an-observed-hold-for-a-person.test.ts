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

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeCommand, isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import { callModel } from '../../packages/core-custody/src/index.ts';
import { effectOperationId } from '../../packages/core-wire/src/index.ts';
import {
  appliedDetail,
  approve,
  asPerson,
  codeOf,
  createTask,
  freshPurpose,
  proposeBody,
  revisionOf,
  type Detail,
} from '../runtime/schedules-harness.ts';
import { PRICED } from '../runtime/t2d-harness.ts';
import { seedLaunch } from '../runtime/launch-seed.ts';
import {
  broker,
  noDatabase,
  requestFor,
  s,
  stepOf,
  useBrokerWorld,
  world,
} from './broker-world.ts';
import { moneyOf, one, people, usePeople } from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('endobserved');
usePeople();

/** The replay operation's priced maximum: one call fits, and the next stops. */
const ONE_CALL = 500;

/** The decider's own synthetic work on a hold of one call, picked up and launched. */
async function personWork(): Promise<{ taskId: string; picked: Detail; attemptId: string }> {
  const taskId = await createTask(s, `end observed ${freshPurpose()}`);
  const body = {
    ...proposeBody(taskId, await revisionOf(s, taskId), {
      purpose: freshPurpose(),
      maximumMinor: ONE_CALL,
    }),
    step: { kind: 'synthetic_comment', payload: {} },
  };
  const decision = await approve(s, appliedDetail(await asPerson(s, body), 'task.propose'));
  const picked = appliedDetail(
    await asPerson(s, {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: decision['reservationId'],
    }),
    'task.pickup',
  );
  await seedLaunch(s, picked);
  return { taskId, picked, attemptId: String(picked['attemptId']) };
}

/** A call under the person's own lease: no delegation, the person attending. */
const personCall = async (w: { taskId: string; picked: Detail }) => {
  const work = { taskId: w.taskId, picked: w.picked, proposal: {}, decision: {} };
  await stepOf(work);
  return await callModel(
    s.db.app,
    s.business,
    { actorId: s.decider.actorId, delegationId: null, attendedByPersonId: s.decider.personId },
    requestFor(work),
    broker,
  );
};

/** The run, its hold and envelope (`moneyOf`), with the attempt's state. */
const stateOf = async (runId: string, attemptId: string) => ({
  ...(await moneyOf(runId)),
  ...(await one<{ attempt: string }>(`select state as attempt from public.attempts where id = $1`, [
    attemptId,
  ])),
});

/** The effect applied, then one call settles and the next stops the run at its ceiling. */
async function stoppedAfterItsEffect() {
  const w = await personWork();
  const lease = { leaseId: w.picked['leaseId'], fence: w.picked['fence'] };
  appliedDetail(
    await asPerson(s, { command: 'task.dispatch', operationId: randomUUID(), ...lease }),
    'task.dispatch',
  );
  appliedDetail(
    await asPerson(s, {
      command: 'task.comment',
      operationId: effectOperationId(w.attemptId),
      recordId: w.taskId,
      expectedRevision: await revisionOf(s, w.taskId),
      body: 'The synthetic change, applied once. Nothing left the app.',
      audience: 'internal',
    }),
    'task.comment',
  );
  world.provider.mode('answer');
  expect((await personCall(w)).ok).toBe(true);
  expect(await personCall(w)).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE' });
  const { run_id: runId } = await one<{ run_id: string }>(
    `select run_id from public.leases where id = $1`,
    [lease.leaseId],
  );
  const { id: askId } = await one<{ id: string }>(
    `select id from public.budget_asks where run_id = $1`,
    [runId],
  );
  return { w, lease, runId, askId };
}

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
