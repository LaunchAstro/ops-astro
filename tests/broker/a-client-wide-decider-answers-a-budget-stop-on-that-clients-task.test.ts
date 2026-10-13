// SPDX-License-Identifier: AGPL-3.0-only
//
// A budget stop on a client's task is answered by a person holding `decide`
// across that client (the party grant Settings > Access issues per client),
// as well as by one holding it on the task or across the business. The same
// person is refused on another client's stopped task and on a stopped task
// with no client, and nothing moves there. Each command keeps its own trash
// rule: the end reaches a trashed task, a top-up does not. A replay answers
// the first outcome and moves nothing more.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { moneyOf, setThreshold, stopped, usePeople } from './budget-answers-world.ts';
import {
  asPerson,
  endBody,
  topUpBody,
  useAnswerRoutes,
  type Answer,
} from './budget-answer-routes-world.ts';
import {
  clientWideDecider,
  underClient,
  usePlanApproverWithoutBilling,
} from './client-budget-answer-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('partybudget');
usePeople();
useAnswerRoutes('partybudget');
usePlanApproverWithoutBilling();

/** The state an applied answer reports. */
const stateOf = (answer: Answer): unknown =>
  (answer.body['detail'] as Readonly<Record<string, unknown>> | undefined)?.['state'];

/** A stop on a task of a new client, and a person deciding across that client. */
async function clientStop(title: string) {
  await setThreshold(null);
  const clientId = randomUUID();
  const target = await stopped(title);
  await underClient(target.work.taskId, clientId);
  return { clientId, target, decider: await clientWideDecider(clientId) };
}

it('a client-wide decider tops up a stop on that client’s task', async () => {
  const { target, decider } = await clientStop('client A’s stopped task, topped up');
  const answer = await asPerson(
    decider,
    '/run/top_up',
    topUpBody(target.work.taskId, target.runId, target.askId),
  );
  expect(answer.body, JSON.stringify(answer.body)).not.toHaveProperty('refused');
  expect(stateOf(answer)).toBe('applied');
});

it('a client-wide decider ends a run at a stop on that client’s task', async () => {
  const { target, decider } = await clientStop('client A’s stopped task, ended');
  const answer = await asPerson(
    decider,
    '/run/end_at_budget_stop',
    endBody(target.work.taskId, target.runId, target.askId),
  );
  expect(answer.body, JSON.stringify(answer.body)).not.toHaveProperty('refused');
  expect(stateOf(answer)).toBe('cancelled');
});

it('a client-wide decider is refused a stop on another client’s task and on a task with no client', async () => {
  await setThreshold(null);
  const clientA = randomUUID();
  const clientB = randomUUID();
  const other = await stopped('client B’s stopped task');
  await underClient(other.work.taskId, clientB);
  const unclaimed = await stopped('a stopped task with no client');
  const decider = await clientWideDecider(clientA);
  for (const target of [other, unclaimed]) {
    // oxlint-disable-next-line no-await-in-loop -- one target at a time reads as a list
    const before = await moneyOf(target.runId);
    for (const [path, body] of [
      ['/run/top_up', topUpBody],
      ['/run/end_at_budget_stop', endBody],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await asPerson(
        decider,
        path,
        body(target.work.taskId, target.runId, target.askId),
      );
      expect(answer.body['code'], path).toBe('SCOPE_NOT_GRANTED');
      expect(JSON.stringify(answer.body)).not.toContain(clientB);
    }
    // oxlint-disable-next-line no-await-in-loop
    expect(await moneyOf(target.runId)).toStrictEqual(before);
  }
});

it('on a trashed client task the end releases the run and a top-up is refused as today', async () => {
  const { target, decider } = await clientStop('a trashed client task');
  await s.db.admin.execute(
    `update public.records set deleted_at = now(), trash_batch_id = $2, deleted_by_actor_id = $3
      where id = $1`,
    [target.work.taskId, randomUUID(), s.decider.actorId],
  );
  const before = await moneyOf(target.runId);
  const topUp = await asPerson(
    decider,
    '/run/top_up',
    topUpBody(target.work.taskId, target.runId, target.askId),
  );
  expect(topUp.body['code']).toBe('NOT_FOUND');
  expect(await moneyOf(target.runId)).toStrictEqual(before);
  const end = await asPerson(
    decider,
    '/run/end_at_budget_stop',
    endBody(target.work.taskId, target.runId, target.askId),
  );
  expect(end.body, JSON.stringify(end.body)).not.toHaveProperty('refused');
  expect(stateOf(end)).toBe('cancelled');
});

it('a replayed client-wide answer gives its first outcome and moves nothing more', async () => {
  const { target, decider } = await clientStop('a replayed client top-up');
  const body = topUpBody(target.work.taskId, target.runId, target.askId);
  const first = await asPerson(decider, '/run/top_up', body);
  expect(stateOf(first), JSON.stringify(first.body)).toBe('applied');
  const after = await moneyOf(target.runId);
  const again = await asPerson(decider, '/run/top_up', body);
  expect(again).toStrictEqual(first);
  expect(await moneyOf(target.runId)).toStrictEqual(after);
});
