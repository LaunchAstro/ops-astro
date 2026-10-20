// SPDX-License-Identifier: AGPL-3.0-only
//
// Above the four-eyes band, two people holding `billing:decide` across a
// task's client are the two approvals a top-up needs: the first is recorded,
// the second completes it. And a plan approver whose only billing authority is
// that client's grant still holds it, so another holder cannot top the run up
// without them. Both judgements read the client under the task lock, as the
// answer's own grant check does.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { noDatabase, useBrokerWorld } from './broker-world.ts';
import { moneyOf, people, setThreshold, stopped, usePeople } from './budget-answers-world.ts';
import { asPerson, topUpBody, useAnswerRoutes, type Answer } from './budget-answer-routes-world.ts';
import {
  clientWideDecider,
  decideAcross,
  underClient,
  usePlanApproverWithoutBilling,
} from './client-budget-answer-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

/** The state an applied answer reports. */
const stateOf = (answer: Answer): unknown =>
  (answer.body['detail'] as Readonly<Record<string, unknown>> | undefined)?.['state'];

useBrokerWorld('partypair');
usePeople();
useAnswerRoutes('partypair');
usePlanApproverWithoutBilling();

it('two client-wide deciders pair a top-up above the four-eyes band', async () => {
  // Five dollars: the 1,000-minor top-up needs a second person.
  await setThreshold(5);
  const clientId = randomUUID();
  const target = await stopped('a client stop above the band');
  await underClient(target.work.taskId, clientId);
  const first = await clientWideDecider(clientId);
  const second = await clientWideDecider(clientId);
  const body = () => topUpBody(target.work.taskId, target.runId, target.askId);

  const recorded = await asPerson(first, '/run/top_up', body());
  expect(stateOf(recorded), JSON.stringify(recorded.body)).toBe('awaiting_second');
  const completed = await asPerson(second, '/run/top_up', body());
  expect(stateOf(completed), JSON.stringify(completed.body)).toBe('applied');
  expect((await moneyOf(target.runId)).approvals).toBe(2);
});

it('a plan approver holding billing across the client still approves, so another holder is refused', async () => {
  await setThreshold(null);
  const clientId = randomUUID();
  const target = await stopped('a client stop whose plan approver decides across the client');
  await underClient(target.work.taskId, clientId);
  await decideAcross(people.approver, clientId, 'billing');
  const before = await moneyOf(target.runId);

  const other = await asPerson(
    people.second,
    '/run/top_up',
    topUpBody(target.work.taskId, target.runId, target.askId),
  );
  expect(other.body['code'], JSON.stringify(other.body)).toBe('SCOPE_NOT_GRANTED');
  expect(await moneyOf(target.runId)).toStrictEqual(before);
});
