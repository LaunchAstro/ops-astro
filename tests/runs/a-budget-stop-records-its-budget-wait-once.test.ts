// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R1, the budget stop's outcome. A run approved at 300 asks for a call
// whose priced maximum is 500: the reserve transaction stops the run, asks,
// retires the lease and its delegation, and in that same transaction records
// the attempt's outcome, `budget_wait / BUDGET_UNAVAILABLE`. Then the worker,
// still holding its old credential, posts `run.end` through the real agent
// door: the stop already took its authority, so that late end changes
// nothing. Again with the reserve's reply lost after commit, so the worker
// asks again under the same operation id: the ask, the retirement and the row
// still commit once. Control: at 2,000 the call proceeds and nothing records
// an outcome.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it as vitestIt } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { cutProxy, liveWork, scalar, type Work } from '../runtime/schedules-harness.ts';
import {
  authorityOf,
  callsOf,
  door,
  modelCall,
  modelCallBody,
  named,
  noDatabase,
  outcomesOf,
  runEnd,
  s,
  shapeOf,
  useStopWorld,
  world,
} from './run-stop-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useStopWorld('sol1623budget');

/** The replay operation's priced maximum is 500: a 300 ceiling cannot hold one call. */
const UNDER_ONE_CALL = 300;

/** The budget asks the work's lease raised. */
const asksOf = async (work: Work): Promise<number> =>
  await scalar(s, 'select count(*)::text as n from public.budget_asks where lease_id = $1', [
    work.picked['leaseId'],
  ]);

/** What a stopped run must show: one row, one ask, its authority gone, nothing sent. */
async function expectStoppedOnce(work: Work, sentBefore: number): Promise<void> {
  expect(shapeOf(await outcomesOf(work)), 'one budget outcome for the attempt').toEqual([
    named('budget_wait', 'BUDGET_UNAVAILABLE'),
  ]);
  expect(await asksOf(work), 'the ask commits once').toBe(1);
  expect(await authorityOf(work)).toEqual({
    lease: 'released',
    cause: 'work_retired',
    run: 'waiting_budget',
  });
  expect(world.provider.seen.length, 'nothing was sent').toBe(sentBefore);
}

/** The worker's late `run.end` on its old credential: refused at the door, nothing moved. */
async function expectLateEndChangesNothing(work: Work, endCode: string): Promise<void> {
  const before = await outcomesOf(work);
  const ended = await runEnd(work, endCode);
  expect(ended.body['code'], 'a retired credential cannot end the run').not.toBe('RUN_ENDED');
  expect(await outcomesOf(work), 'the late end changes no outcome').toEqual(before);
  expect(await asksOf(work)).toBe(1);
}

it('a budget stop records budget_wait in its own transaction, and a late run.end changes nothing', async () => {
  const work = await liveWork(s, `sol1623 budget stop ${randomUUID()}`, UNDER_ONE_CALL);
  world.provider.mode('answer');
  const sent = world.provider.seen.length;

  const stopped = await modelCall(work);
  expect(stopped.body['code'], 'setup: the ceiling stops the call').toBe('BUDGET_UNAVAILABLE');

  await expectStoppedOnce(work, sent);
  await expectLateEndChangesNothing(work, 'TOOL_REFUSED');
  await expectStoppedOnce(work, sent);
});

it('a budget stop whose reply is lost after commit records its outcome once', async () => {
  const work = await liveWork(s, `sol1623 budget reply lost ${randomUUID()}`, UNDER_ONE_CALL);
  world.provider.mode('answer');
  const sent = world.provider.seen.length;
  const body = modelCallBody(work);

  // The reserve transaction commits; its COMMIT's answer never reaches the
  // door, so the worker hears nothing back and asks again with the same id.
  const proxy = await cutProxy(s.db.appUrl, 'after-commit');
  const cut = connect(proxy.url, { source: 'sol1623 lost reply' });
  try {
    await modelCall(work, door(cut), body).catch(() => null);
    expect(proxy.cut(), 'setup: the reserve reply was lost').toBe(true);
  } finally {
    // A pool whose one connection was cut may never finish ending; it is let
    // go of after a second rather than awaited for ever.
    await Promise.race([cut.close().catch(() => null), delay(1_000)]);
    await proxy.close();
  }
  expect(await asksOf(work), 'setup: the stop committed before its reply was lost').toBe(1);

  const again = await modelCall(work, door(), body);
  expect(again.body['code'], 'the same operation replays its stop').toBe('BUDGET_UNAVAILABLE');

  await expectStoppedOnce(work, sent);
  await expectLateEndChangesNothing(work, 'ANSWER_LOST');
  await expectStoppedOnce(work, sent);
});

it('control: a ceiling that holds the call lets it proceed, and no outcome is written', async () => {
  const work = await liveWork(s, `sol1623 budget control ${randomUUID()}`, 2_000);
  world.provider.mode('answer');
  const sent = world.provider.seen.length;

  const answered = await modelCall(work);
  expect(answered.status).toBe(200);
  expect(answered.body['detail']).toMatchObject({ state: 'settled', actualMinor: 100 });
  expect(world.provider.seen.length).toBe(sent + 1);
  expect((await callsOf(work)).map((row) => row.state)).toEqual(['settled']);

  expect(
    await outcomesOf(work),
    'a live attempt that spent within its ceiling has no outcome',
  ).toEqual([]);
  expect(await asksOf(work)).toBe(0);
  expect(await authorityOf(work)).toMatchObject({ lease: 'live', cause: null });
});
