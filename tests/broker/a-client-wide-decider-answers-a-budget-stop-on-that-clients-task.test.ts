// SPDX-License-Identifier: AGPL-3.0-only
//
// A budget stop on a client's task is answered by a person holding `decide`
// across that client (the party grant Settings > Access issues per client),
// as well as by one holding it on the task or across the business. The same
// person is refused on another client's stopped task and on a stopped task
// with no client, with the bytes a person holding nothing gets, and nothing
// moves there.
//
// No client task reaches a model call through the broker yet (C60), so each
// stopped task is put under its client by the admin connection after it stops.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { clientHere } from '../reads/client-rows.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { moneyOf, setThreshold, stopped, usePeople } from './budget-answers-world.ts';
import { asPerson, endBody, topUpBody, useAnswerRoutes } from './budget-answer-routes-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('partybudget');
usePeople();
useAnswerRoutes('partybudget');

async function underClient(taskId: string, clientId: string): Promise<void> {
  await clientHere(s.db.admin, s.business, clientId);
  await s.db.admin.execute(
    'update public.records set uuid_7 = $3::uuid where business_id = $1 and id = $2::uuid',
    [s.business, taskId, clientId],
  );
}

async function clientWideDecider(clientId: string): Promise<Member> {
  const member = await enrol(s.db.app, s.business, `client-decider-${randomUUID()}`);
  await s.db.app.withBusiness(s.business, async (tx) => {
    const scope = { kind: 'party', id: clientId } as const;
    await grantTo(tx, member, 'read', scope);
    await grantTo(tx, member, 'decide', scope, false, 'billing');
    await grantTo(tx, member, 'decide', scope, false, 'gate');
  });
  return member;
}

it('a client-wide decider tops up a stop on that client’s task', async () => {
  await setThreshold(null);
  const clientA = randomUUID();
  const target = await stopped('client A’s stopped task, topped up');
  await underClient(target.work.taskId, clientA);
  const decider = await clientWideDecider(clientA);
  const answer = await asPerson(
    decider,
    '/run/top_up',
    topUpBody(target.work.taskId, target.runId, target.askId),
  );
  expect(answer.body, JSON.stringify(answer.body)).not.toHaveProperty('refused');
  expect(answer.status).toBe(200);
});

it('a client-wide decider ends a run at a stop on that client’s task', async () => {
  await setThreshold(null);
  const clientA = randomUUID();
  const target = await stopped('client A’s stopped task, ended');
  await underClient(target.work.taskId, clientA);
  const decider = await clientWideDecider(clientA);
  const answer = await asPerson(
    decider,
    '/run/end_at_budget_stop',
    endBody(target.work.taskId, target.runId, target.askId),
  );
  expect(answer.body, JSON.stringify(answer.body)).not.toHaveProperty('refused');
  expect(answer.status).toBe(200);
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
