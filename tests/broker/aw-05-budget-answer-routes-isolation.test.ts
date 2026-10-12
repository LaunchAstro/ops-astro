// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05's answers at parity, the three crossings over the real boundary.
// Another business's decider on their own prefix, naming this business's
// task and run; this business's plan approver naming another task's run
// under this task, beside a made-up run, which answer with the same bytes;
// and another client: the two tasks are linked to two stored clients, and a
// person whose grants cover client B and its task alone names client A's run.
// The third crossing, an agent under a live delegation, is the
// agent case in `aw-05-budget-answer-routes.test.ts`. No refusal names the
// other run or either task, and nothing moves.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { enrol, grantTo } from '../commands/fixture.ts';
import type { Work } from '../runtime/schedules-harness.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { moneyOf, one, people, setThreshold, stopped, usePeople } from './budget-answers-world.ts';
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
  readonly askId: string;
}

/** Bravo's decider, on bravo's own prefix, naming alpha's task and run. */
async function fromAnotherBusiness(target: Stopped): Promise<readonly Answer[]> {
  const { work, runId, askId } = target;
  const answers = [
    await asPerson(bravo.decider, '/run/top_up', topUpBody(work.taskId, runId, askId), bravoKey),
    await asPerson(
      bravo.decider,
      '/run/end_at_budget_stop',
      endBody(work.taskId, runId, askId),
      bravoKey,
    ),
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
    const crossed = await asPerson(people.approver, path, body(taskId, other.runId, other.askId));
    // eslint-disable-next-line no-await-in-loop
    const fabricated = await asPerson(
      people.approver,
      path,
      body(taskId, randomUUID(), randomUUID()),
    );
    expect(crossed.body['code'], path).toBe('NOT_FOUND');
    expect(bytesOf(crossed), path).toBe(bytesOf(fabricated));
    answers.push(crossed);
  }
  return answers;
}

/** A stored client of this business, and `taskId` linked to it on the record's spine. */
async function underNewClient(taskId: string): Promise<string> {
  const client = randomUUID();
  await s.db.admin.execute(
    `insert into public.clients (business_id, id, name, created_by_actor_id)
     values ($1, $2, $3, $4)`,
    [s.business, client, `aw05 client ${client.slice(0, 8)}`, s.decider.actorId],
  );
  await s.db.admin.execute(
    `update public.records set data = data || jsonb_build_object('client', $2::text) where id = $1`,
    [taskId, client],
  );
  return client;
}

/** The task's client, as the record's spine holds it. */
const clientOf = async (taskId: string): Promise<string | null> =>
  (
    await one<{ client: string | null }>(
      'select uuid_7::text as client from public.records where id = $1',
      [taskId],
    )
  ).client;

/** Client B's person: grants on client B and its task alone, naming client A's run. */
async function fromAnotherClient(target: Stopped, other: Stopped): Promise<readonly Answer[]> {
  const clientA = await underNewClient(target.work.taskId);
  const clientB = await underNewClient(other.work.taskId);
  // A real crossing: two stored clients, both linked, not the same one.
  expect(await clientOf(target.work.taskId)).toBe(clientA);
  expect(await clientOf(other.work.taskId)).toBe(clientB);
  expect(clientA).not.toBe(clientB);
  const narrow = await enrol(s.db.app, s.business, 'narrow');
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const scope of [
      { kind: 'party', id: clientB },
      { kind: 'record', id: other.work.taskId },
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- two grants, one scope each
      await grantTo(tx, narrow, 'decide', scope, false, 'billing');
      // eslint-disable-next-line no-await-in-loop
      await grantTo(tx, narrow, 'decide', scope, false, 'gate');
    }
  });
  const { work, runId, askId } = target;
  const answers = [
    await asPerson(narrow, '/run/top_up', topUpBody(work.taskId, runId, askId)),
    await asPerson(narrow, '/run/end_at_budget_stop', endBody(work.taskId, runId, askId)),
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
    ...(await fromAnotherClient(target, other)),
  ];

  for (const answer of answers) {
    expect(JSON.stringify(answer.body)).not.toContain(other.runId);
    expect(JSON.stringify(answer.body)).not.toContain(other.work.taskId);
  }
  expect(await moneyOf(target.runId)).toStrictEqual(before);
  expect(await moneyOf(other.runId)).toStrictEqual(otherBefore);
});
