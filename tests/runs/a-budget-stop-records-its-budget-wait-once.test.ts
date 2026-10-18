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
// still commit once. Past the run's consolidated (third) ask the stop raises no
// fourth and ends the run, and the attempt still records `budget_wait` once
// (ORCH-DECISION LOOP-LASTASK). Control: at 2,000 the call proceeds and
// nothing records an outcome.

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

/**
 * The run's three asks already raised, the third its consolidated decision,
 * each in the terms the plan was approved in: a run that has asked all it may.
 */
async function asksSpent(work: Work): Promise<void> {
  await s.db.admin.execute(
    `insert into public.budget_asks
       (business_id, id, run_id, reservation_id, lease_id, decision_id, ask_number, kind,
        ceiling_minor, spent_minor, currency)
     select l.business_id, gen_random_uuid(), l.run_id, l.reservation_id, l.id, d.id, n,
            case when n = 3 then 'consolidated' else 'stop' end, r.held_minor, 0, env.currency
       from public.leases l
       join public.reservations r on r.business_id = l.business_id and r.id = l.reservation_id
       join public.task_envelopes env on env.business_id = r.business_id and env.id = r.envelope_id
       join lateral (
         select id from public.gate_decisions
          where business_id = r.business_id and version_id = r.version_id and decision = 'approve'
          order by seq desc limit 1
       ) d on true
       cross join generate_series(1, 3) as n
      where l.id = $1`,
    [work.picked['leaseId']],
  );
}

it('a budget stop past the consolidated ask ends the run, asks no fourth time and records budget_wait once', async () => {
  const work = await liveWork(
    s,
    `sol1623 budget past the last ask ${randomUUID()}`,
    UNDER_ONE_CALL,
  );
  await asksSpent(work);
  world.provider.mode('answer');
  const sent = world.provider.seen.length;

  const stopped = await modelCall(work);
  expect(stopped.body['code'], 'setup: the ceiling stops the call').toBe('BUDGET_UNAVAILABLE');

  expect(shapeOf(await outcomesOf(work)), 'one budget outcome for the attempt').toEqual([
    named('budget_wait', 'BUDGET_UNAVAILABLE'),
  ]);
  expect(await asksOf(work), 'no fourth ask').toBe(3);
  expect(await authorityOf(work)).toEqual({
    lease: 'released',
    cause: 'work_retired',
    run: 'cancelled',
  });
  expect(world.provider.seen.length, 'nothing was sent').toBe(sent);
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
