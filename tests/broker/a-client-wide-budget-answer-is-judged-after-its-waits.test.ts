// SPDX-License-Identifier: AGPL-3.0-only
//
// A client-wide budget answer is judged after it has waited, on two separate
// connections, in the two places it can wait. A revocation of the client grant
// that the answer waits for in its grant hold commits first, and the answer is
// refused. A client grant that expires while the answer waits on the run's
// lock has expired by the time it is judged, and the answer is refused. Each
// wait is shown on the server before it is released, and neither refusal
// moves any money.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { moneyOf, setThreshold, stopped, usePeople } from './budget-answers-world.ts';
import { asPerson, topUpBody, useAnswerRoutes } from './budget-answer-routes-world.ts';
import {
  backendOf,
  decideAcross,
  someoneBlockedBy,
  underClient,
  usePlanApproverWithoutBilling,
} from './client-budget-answer-world.ts';
import { enrol, grantTo } from '../commands/fixture.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('partywait');
usePeople();
useAnswerRoutes('partywait');
usePlanApproverWithoutBilling();

/** A second application connection: it holds each lock, so the owner connection stays free to watch. */
let holderDb: Database | undefined;
beforeAll(() => {
  if (!noDatabase) holderDb = connect(s.db.appUrl, { source: 'runtime' });
});
afterAll(async () => {
  await holderDb?.close();
});

/** Runs `hold` in one transaction on the second connection, handing it a query function. */
async function holdOn(
  hold: (
    execute: (sql: string, params?: readonly unknown[]) => Promise<readonly unknown[]>,
  ) => Promise<void>,
): Promise<void> {
  if (holderDb === undefined) throw new Error('no second connection');
  await holderDb.withBusiness(s.business, async (tx) => {
    await hold(async (sql, params = []) => await tx.query(sql, params));
  });
}

/** A stop on a client's task, and a top-up decider whose billing grant is across that client only. */
async function waitingAnswer(title: string) {
  await setThreshold(null);
  const clientId = randomUUID();
  const target = await stopped(title);
  await underClient(target.work.taskId, clientId);
  const decider = await enrol(s.db.app, s.business, `waiting-decider-${randomUUID()}`);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, decider, 'read', { kind: 'party', id: clientId });
  });
  const billing = await decideAcross(decider, clientId, 'billing');
  return { target, decider, billing };
}

/** A promise and the call that settles it. */
function latch(): { readonly promise: Promise<void>; readonly open: () => void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, open: () => settle?.() };
}

it('a client grant revoked while the answer waits on it is refused after the wait', async () => {
  const { target, decider, billing } = await waitingAnswer('a stop whose client grant is revoked');
  const before = await moneyOf(target.runId);
  const holding = latch();
  const commit = latch();
  let holder = 0;
  const revocation = holdOn(async (execute) => {
    holder = await backendOf(execute);
    await execute('update public.grants set revoked_at = clock_timestamp() where id = $1', [
      billing,
    ]);
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
    await revocation;
  }
  const settled = await answer;
  expect(settled.body['code'], JSON.stringify(settled.body)).toBe('SCOPE_NOT_GRANTED');
  expect(await moneyOf(target.runId)).toStrictEqual(before);
}, 90_000);

it('a client grant that expires while the answer waits on the run lock is refused after the wait', async () => {
  const { target, decider, billing } = await waitingAnswer('a stop whose client grant expires');
  await s.db.admin.execute(
    "update public.grants set expires_at = clock_timestamp() + interval '4 seconds' where id = $1",
    [billing],
  );
  const before = await moneyOf(target.runId);
  const holding = latch();
  const release = latch();
  let holder = 0;
  const runLock = holdOn(async (execute) => {
    holder = await backendOf(execute);
    await execute('select 1 from public.planned_runs where id = $1 for update', [target.runId]);
    holding.open();
    await release.promise;
  });
  await holding.promise;
  const answer = asPerson(
    decider,
    '/run/top_up',
    topUpBody(target.work.taskId, target.runId, target.askId),
  );
  try {
    await someoneBlockedBy(holder);
    // Hold the run until the grant has expired on the database's clock.
    const deadline = Date.now() + 30_000;
    // oxlint-disable-next-line no-await-in-loop -- one probe at a time until it expires
    while (Date.now() < deadline && (await liveGrant(billing))) await pause(200);
    expect(await liveGrant(billing)).toBe(false);
  } finally {
    release.open();
    await runLock;
  }
  const settled = await answer;
  expect(settled.body['code'], JSON.stringify(settled.body)).toBe('SCOPE_NOT_GRANTED');
  expect(await moneyOf(target.runId)).toStrictEqual(before);
}, 90_000);

async function liveGrant(id: string): Promise<boolean> {
  const rows = await s.db.admin.execute(
    'select 1 from public.grants where id = $1 and expires_at > clock_timestamp()',
    [id],
  );
  return rows.length > 0;
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
