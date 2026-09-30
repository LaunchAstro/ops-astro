// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05's answers at parity, the three crossings over the real boundary.
// Another business's decider on their own prefix, naming this business's
// task and run; this business's plan approver naming another task's run
// under this task, beside a made-up run, which answer with the same bytes;
// and a person whose grants cover another task only (the client stand-in
// until C32). The third crossing, an agent under a live delegation, is the
// agent case in `aw-05-budget-answer-routes.test.ts`. No refusal names the
// other run or either task, and nothing moves.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { enrol, grantTo } from '../commands/fixture.ts';
import type { Work } from '../runtime/schedules-harness.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { moneyOf, people, setThreshold, stopped, usePeople } from './budget-answers-world.ts';
import {
  asPerson,
  bravo,
  bravoKey,
  bytesOf,
  endBody,
  topUpBody,
  useAnswerRoutes,
  type Answer,
} from './budget-answer-routes-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('aw05routesiso');
usePeople();
useAnswerRoutes('aw05routesiso');

interface Stopped {
  readonly work: Work;
  readonly runId: string;
}

/** Bravo's decider, on bravo's own prefix, naming alpha's task and run. */
async function fromAnotherBusiness(target: Stopped): Promise<readonly Answer[]> {
  const { work, runId } = target;
  const answers = [
    await asPerson(bravo.decider, '/run/top_up', topUpBody(work.taskId, runId), bravoKey),
    await asPerson(bravo.decider, '/run/end_at_budget_stop', endBody(work.taskId, runId), bravoKey),
  ];
  for (const answer of answers) {
    expect(answer.body['code']).toBe('NOT_FOUND');
    expect(JSON.stringify(answer.body)).not.toContain(work.taskId);
  }
  return answers;
}

/** Another task's run under this task's name, and a made-up run: the same bytes. */
async function fromAnotherTask(target: Stopped, other: Stopped): Promise<readonly Answer[]> {
  const taskId = target.work.taskId;
  const answers: Answer[] = [];
  for (const [path, body] of [
    ['/run/top_up', topUpBody],
    ['/run/end_at_budget_stop', endBody],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- one crossing at a time reads as a list
    const crossed = await asPerson(people.approver, path, body(taskId, other.runId));
    // eslint-disable-next-line no-await-in-loop
    const fabricated = await asPerson(people.approver, path, body(taskId, randomUUID()));
    expect(crossed.body['code'], path).toBe('NOT_FOUND');
    expect(bytesOf(crossed), path).toBe(bytesOf(fabricated));
    answers.push(crossed);
  }
  return answers;
}

/** A person whose grants cover the other task only. */
async function fromOutsideTheGrant(target: Stopped, other: Stopped): Promise<readonly Answer[]> {
  const narrow = await enrol(s.db.app, s.business, 'narrow');
  await s.db.app.withBusiness(s.business, async (tx) => {
    const scope = { kind: 'record', id: other.work.taskId } as const;
    await grantTo(tx, narrow, 'decide', scope, false, 'billing');
    await grantTo(tx, narrow, 'decide', scope, false, 'gate');
  });
  const { work, runId } = target;
  const answers = [
    await asPerson(narrow, '/run/top_up', topUpBody(work.taskId, runId)),
    await asPerson(narrow, '/run/end_at_budget_stop', endBody(work.taskId, runId)),
  ];
  for (const answer of answers) expect(answer.body['code']).toBe('SCOPE_NOT_GRANTED');
  return answers;
}

it('AW-05 isolation: the answer routes', async () => {
  await setThreshold(null);
  const target = await stopped('the run the crossings aim at');
  const other = await stopped('a run on another task in the same business');
  const before = await moneyOf(target.runId);
  const otherBefore = await moneyOf(other.runId);

  const answers = [
    ...(await fromAnotherBusiness(target)),
    ...(await fromAnotherTask(target, other)),
    ...(await fromOutsideTheGrant(target, other)),
  ];

  for (const answer of answers) {
    expect(JSON.stringify(answer.body)).not.toContain(other.runId);
    expect(JSON.stringify(answer.body)).not.toContain(other.work.taskId);
  }
  expect(await moneyOf(target.runId)).toStrictEqual(before);
  expect(await moneyOf(other.runId)).toStrictEqual(otherBefore);
});
