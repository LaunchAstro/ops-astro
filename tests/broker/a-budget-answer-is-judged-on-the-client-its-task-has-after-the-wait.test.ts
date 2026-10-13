// SPDX-License-Identifier: AGPL-3.0-only
//
// A client-wide budget answer is judged on the client the task has once the
// answer holds the task, not the one it read before waiting. On two separate
// connections: a move of the task to another client, in flight when the
// answer starts, commits while the answer waits on the task row, and a
// decider of the old client only is refused with nothing moved. And a first
// approval pairs only with a first approver still deciding across the client:
// one whose client grant was revoked before the second answer leaves the
// top-up waiting for another person. A crash at each write of a client-wide
// pair applies nothing, and the same answer sent again applies it once.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { clientHere } from '../reads/client-rows.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { failingAt, moneyOf, setThreshold, stopped, usePeople } from './budget-answers-world.ts';
import { asPerson, topUpBody, useAnswerRoutes, type Answer } from './budget-answer-routes-world.ts';
import {
  backendOf,
  clientWideDecider,
  someoneBlockedBy,
  underClient,
  usePlanApproverWithoutBilling,
} from './client-budget-answer-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('partymove');
usePeople();
useAnswerRoutes('partymove');
usePlanApproverWithoutBilling();

/** The boundary's answer to a planted crash: a server failure, its body not JSON. */
const SERVER_FAILED = /"Internal S/u;

/** The state an applied answer reports. */
const stateOf = (answer: Answer): unknown =>
  (answer.body['detail'] as Readonly<Record<string, unknown>> | undefined)?.['state'];

/** A second application connection: it holds the task row, so the owner connection stays free to watch. */
let holderDb: Database | undefined;
beforeAll(() => {
  if (!noDatabase) holderDb = connect(s.db.appUrl, { source: 'runtime' });
});
afterAll(async () => {
  await holderDb?.close();
});

/** A promise and the call that settles it. */
function latch(): { readonly promise: Promise<void>; readonly open: () => void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, open: () => settle?.() };
}

async function clientOf(taskId: string): Promise<string | null> {
  const [row] = await s.db.admin.execute<{ client: string | null }>(
    'select uuid_7::text as client from public.records where id = $1::uuid',
    [taskId],
  );
  return row?.client ?? null;
}

it('a task moved to another client while the answer waits on it is answered only by that client’s deciders', async () => {
  await setThreshold(null);
  const oldClient = randomUUID();
  const newClient = randomUUID();
  const target = await stopped('a client stop whose task moves client');
  await underClient(target.work.taskId, oldClient);
  await clientHere(s.db.admin, s.business, newClient);
  const decider = await clientWideDecider(oldClient);
  const before = await moneyOf(target.runId);
  if (holderDb === undefined) throw new Error('no second connection');

  const holding = latch();
  const commit = latch();
  let holder = 0;
  const move = holderDb.withBusiness(s.business, async (tx) => {
    holder = await backendOf(async (sql, params = []) => await tx.query(sql, params));
    await tx.query(
      `update public.records set data = data || jsonb_build_object('client', $3::text)
        where business_id = $1 and id = $2::uuid`,
      [s.business, target.work.taskId, newClient],
    );
    holding.open();
    await commit.promise;
  });
  await holding.promise;
  const answer = asPerson(
    decider,
    '/run/top_up',
    topUpBody(target.work.taskId, target.runId, target.askId),
  );
  try {
    await someoneBlockedBy(holder);
  } finally {
    commit.open();
    await move;
  }
  const settled = await answer;
  expect(await clientOf(target.work.taskId)).toBe(newClient);
  expect(settled.body['code'], JSON.stringify(settled.body)).toBe('SCOPE_NOT_GRANTED');
  expect(await moneyOf(target.runId)).toStrictEqual(before);
}, 90_000);

it('a first approver whose client grant was revoked before the second answer does not pair', async () => {
  // Five dollars: the 1,000-minor top-up needs a second person.
  await setThreshold(5);
  const clientId = randomUUID();
  const target = await stopped('a client stop whose first approver loses the client');
  await underClient(target.work.taskId, clientId);
  const first = await clientWideDecider(clientId);
  const second = await clientWideDecider(clientId);
  const body = () => topUpBody(target.work.taskId, target.runId, target.askId);

  const recorded = await asPerson(first, '/run/top_up', body());
  expect(stateOf(recorded), JSON.stringify(recorded.body)).toBe('awaiting_second');
  const grants = await s.db.admin.execute<{ id: string }>(
    `select id from public.grants
      where business_id = $1 and subject_kind = 'person' and subject_id = $2
        and collection = 'billing' and action = 'decide' and scope_kind = 'party'
        and revoked_at is null`,
    [s.business, first.personId],
  );
  expect(grants).toHaveLength(1);
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const grant of grants) {
      // oxlint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
      await revokeGrant(tx, grant.id);
    }
  });
  const held = await moneyOf(target.runId);

  const unpaired = await asPerson(second, '/run/top_up', body());
  expect(stateOf(unpaired), JSON.stringify(unpaired.body)).toBe('awaiting_second');
  const after = await moneyOf(target.runId);
  expect(after.run).toBe(held.run);
  expect(after.held).toBe(held.held);
  expect(after.answers).toBe(held.answers);
}, 90_000);

it('a client-wide top-up that fails at any write applies nothing, and the same answer sent again applies once', async () => {
  await setThreshold(5);
  const clientId = randomUUID();
  const target = await stopped('a client stop whose answers crash');
  await underClient(target.work.taskId, clientId);
  const first = await clientWideDecider(clientId);
  const second = await clientWideDecider(clientId);
  const before = await moneyOf(target.runId);
  const firstBody = topUpBody(target.work.taskId, target.runId, target.askId);

  const lost = await failingAt('budget_approvals', 'insert', () =>
    asPerson(first, '/run/top_up', firstBody),
  );
  expect(String(lost)).toMatch(SERVER_FAILED);
  expect(await moneyOf(target.runId)).toStrictEqual(before);
  const recorded = await asPerson(first, '/run/top_up', firstBody);
  expect(stateOf(recorded), JSON.stringify(recorded.body)).toBe('awaiting_second');
  const approved = await moneyOf(target.runId);

  const secondBody = topUpBody(target.work.taskId, target.runId, target.askId);
  for (const [table, event] of [
    ['budget_approvals', 'insert'],
    ['budget_answers', 'insert'],
    ['reservations', 'update'],
    ['task_envelopes', 'update'],
    ['planned_runs', 'update'],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop -- one planted crash at a time
    const crashed = await failingAt(table, event, () =>
      asPerson(second, '/run/top_up', secondBody),
    );
    expect(String(crashed), table).toMatch(SERVER_FAILED);
    // oxlint-disable-next-line no-await-in-loop
    expect(await moneyOf(target.runId)).toStrictEqual(approved);
  }

  const applied = await asPerson(second, '/run/top_up', secondBody);
  expect(stateOf(applied), JSON.stringify(applied.body)).toBe('applied');
  const after = await moneyOf(target.runId);
  expect(after.answers).toBe(approved.answers + 1);
  expect(await asPerson(second, '/run/top_up', secondBody)).toStrictEqual(applied);
  expect(await moneyOf(target.runId)).toStrictEqual(after);
}, 120_000);
