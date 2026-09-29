// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05, the budget wait: the approved ceiling is the stop. A model call that
// would take the run past its reservation is refused, and in the same
// transaction the run stops and asks: the ask records the ceiling, the spend
// to date and the decision that approved the plan, the count is persisted,
// the lease ends and its delegation is retired, and the reservation stays
// held for the person's answer. Nothing but that answer takes the run out of
// the wait: no machine path, restart recovery included.
//
// Built ahead: the question's place in the conversation leans on SL12 (U31,
// U32) and AW-04's origin conversation; the answers (top-up, end) are in
// aw-05-budget-top-up, aw-05-budget-end and aw-05-budget-restart.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { callModel } from '../../packages/core-custody/src/index.ts';
import { replayRecordedTransitions } from '../../packages/core-runtime/src/index.ts';
import { liveWork, racer, type Work } from '../runtime/schedules-harness.ts';
import {
  broker,
  call,
  caller,
  noDatabase,
  requestFor,
  rowsOnLease,
  s,
  stepOf,
  useBrokerWorld,
  world,
} from './broker-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('aw05wait');

/** The replay operation's priced maximum is 500 minor units: a 400 ceiling cannot hold one call. */
const UNDER_ONE_CALL = 400;

const one = async <Row>(sql: string, params: readonly unknown[]): Promise<Row> => {
  const [row] = await s.db.admin.execute<Row>(sql, params);
  if (row === undefined) throw new Error(`no row for: ${sql.slice(0, 60)}`);
  return row;
};

const runOf = async (work: Work): Promise<string> =>
  (
    await one<{ run_id: string }>(`select run_id from public.leases where id = $1`, [
      work.picked['leaseId'],
    ])
  ).run_id;

interface Ask {
  readonly ask_number: number;
  readonly kind: string;
  readonly ceiling_minor: string;
  readonly spent_minor: string;
  readonly currency: string;
  readonly decision_id: string;
  readonly reservation_id: string;
  readonly lease_id: string;
}

const asksOf = async (runId: string): Promise<readonly Ask[]> =>
  await s.db.admin.execute<Ask>(
    `select ask_number, kind, ceiling_minor::text as ceiling_minor,
            spent_minor::text as spent_minor, currency, decision_id::text as decision_id,
            reservation_id::text as reservation_id, lease_id::text as lease_id
       from public.budget_asks where run_id = $1 order by ask_number`,
    [runId],
  );

/** Run, lease, delegation and reservation as the wait leaves them. */
const stateOf = async (work: Work, runId: string) =>
  await one<{
    run: string;
    lease: string;
    cause: string | null;
    reservation: string;
    held: string;
  }>(
    `select run.state as run, l.state as lease, d.revocation_cause as cause,
            r.state as reservation, r.held_minor::text as held
       from public.leases l
       join public.planned_runs run on run.id = l.run_id
       join public.delegations d on d.id = l.delegation_id
       join public.reservations r on r.id = l.reservation_id
      where l.id = $1 and run.id = $2`,
    [work.picked['leaseId'], runId],
  );

/** A run stopped at its ceiling, and what the stopping call answered. */
const stopped = async (title: string) => {
  const work = await liveWork(s, title, UNDER_ONE_CALL);
  world.provider.mode('answer');
  const seen = world.provider.seen.length;
  const result = await call(work);
  return { work, runId: await runOf(work), result, sent: world.provider.seen.length - seen };
};

it('the_ceiling_stops_and_asks_where_the_plan_was_approved', async () => {
  const { work, runId, result, sent } = await stopped('aw05 the ceiling stops');

  expect(result.ok).toBe(false);
  expect(result.ok ? null : result.code).toBe('BUDGET_UNAVAILABLE');
  expect(sent).toBe(0);
  // Nothing is held or in flight: the one row is the refused step.
  const calls = await rowsOnLease(work);
  expect(calls).toHaveLength(1);
  const [refusedCall] = await s.db.admin.execute<{ state: string; reserved_minor: string }>(
    `select state, reserved_minor::text as reserved_minor from public.model_calls where lease_id = $1`,
    [work.picked['leaseId']],
  );
  expect(refusedCall).toEqual({ state: 'refused', reserved_minor: '0' });

  // It asks, once, in the terms approved: the ceiling, the spend so far, and
  // the decision the plan was approved by. The conversation that decision was
  // taken in is AW-04's origin (LEANS-ON SL12 U31/U32, AW-04).
  const asks = await asksOf(runId);
  expect(asks).toEqual([
    {
      ask_number: 1,
      kind: 'stop',
      ceiling_minor: String(UNDER_ONE_CALL),
      spent_minor: '0',
      currency: 'AUD',
      decision_id: work.decision['decisionId'],
      reservation_id: work.decision['reservationId'],
      lease_id: work.picked['leaseId'],
    },
  ]);

  // The run waits; its lease is over and its delegation retired, so nothing
  // can spend; the approved ceiling stays reserved for the answer.
  expect(await stateOf(work, runId)).toEqual({
    run: 'waiting_budget',
    lease: 'released',
    cause: 'work_retired',
    reservation: 'held',
    held: String(UNDER_ONE_CALL),
  });
});

it('AW-05 nothing spends while the run waits', async () => {
  const { work, runId } = await stopped('aw05 nothing spends');
  const seen = world.provider.seen.length;
  const again = await call(work);
  expect(again.ok).toBe(false);
  expect(world.provider.seen.length).toBe(seen);
  const held = await s.db.admin.execute(
    `select 1 from public.model_calls where lease_id = $1 and state in ('reserved', 'dispatched')`,
    [work.picked['leaseId']],
  );
  expect(held).toHaveLength(0);
  // A second refusal is not a second ask.
  expect(await asksOf(runId)).toHaveLength(1);
});

it('AW-05 no machine path out of the wait', async () => {
  const { work, runId } = await stopped('aw05 no machine path');
  for (const to of ['planned', 'claimed', 'handed_back', 'cancelled']) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await s.db.app
      .withBusiness(s.business, async (tx) => {
        await tx.query(
          `update public.planned_runs set state = $2 where business_id = $1 and id = $3`,
          [tx.businessId, to, runId],
        );
        return 'ok';
      })
      .catch((error: unknown) => String((error as { code?: string }).code));
    expect(`${to}: ${outcome}`).toBe(`${to}: 23514`);
  }
  // Restart recovery finds a released lease and a retired delegation and
  // leaves the waiting run's hold alone: the wait is not a clock.
  await s.db.app.withBusiness(s.business, async (tx) => await replayRecordedTransitions(tx));
  expect(await stateOf(work, runId)).toMatchObject({ run: 'waiting_budget', reservation: 'held' });
  expect(await asksOf(runId)).toHaveLength(1);
});

it('AW-05 a restart keeps the ask count', async () => {
  const { runId } = await stopped('aw05 restart keeps the count');
  await s.db.app.withBusiness(s.business, async (tx) => await replayRecordedTransitions(tx));
  const asks = await asksOf(runId);
  expect(asks.map((ask) => ask.ask_number)).toEqual([1]);
});

it('AW-05 the ask count is bounded: three asks, the third consolidated', async () => {
  const { work, runId } = await stopped('aw05 three asks');
  const [first] = await asksOf(runId);
  if (first === undefined) throw new Error('no first ask');
  const insert = async (askNumber: number, kind: string): Promise<string> =>
    await s.db.admin
      .execute(
        `insert into public.budget_asks
           (business_id, id, run_id, reservation_id, lease_id, decision_id, ask_number, kind,
            ceiling_minor, spent_minor, currency)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 400, 0, 'AUD')`,
        [
          s.business,
          randomUUID(),
          runId,
          first.reservation_id,
          first.lease_id,
          first.decision_id,
          askNumber,
          kind,
        ],
      )
      .then(() => 'ok')
      .catch((error: unknown) => String((error as { code?: string }).code));
  expect(await insert(1, 'stop')).toBe('23505');
  expect(await insert(2, 'consolidated')).toBe('23514');
  expect(await insert(3, 'stop')).toBe('23514');
  expect(await insert(4, 'consolidated')).toBe('23514');
  expect(await insert(0, 'stop')).toBe('23514');
  expect(await insert(2, 'stop')).toBe('ok');
  expect(await insert(3, 'consolidated')).toBe('ok');
  expect(work.taskId).toBeTruthy();
});

it('AW-05 asks are append-only', async () => {
  const { runId } = await stopped('aw05 append-only');
  const outcome = async (sql: string): Promise<string> =>
    await s.db.app
      .withBusiness(s.business, async (tx) => {
        await tx.query(sql, [runId]);
        return 'ok';
      })
      .catch((error: unknown) => String((error as { code?: string }).code));
  expect(await outcome(`update public.budget_asks set spent_minor = 0 where run_id = $1`)).toBe(
    '42501',
  );
  expect(await outcome(`delete from public.budget_asks where run_id = $1`)).toBe('42501');
});

it('AW-05 two calls reaching the ceiling at once stop the run once', async () => {
  const work = await liveWork(s, 'aw05 two at once', UNDER_ONE_CALL);
  await stepOf(work);
  const runId = await runOf(work);
  const seen = world.provider.seen.length;
  // Two connections of their own: the second waits on the rows the first holds
  // (the run, then the lease) and finds its lease over. The lease lock alone
  // makes this one ask; the run lock keeps the contract order (task, run,
  // lease) for the run update.
  const [first, second] = [racer(s), racer(s)];
  try {
    const answers = await Promise.all(
      [first, second].map(
        async (db) => await callModel(db, s.business, caller(work), requestFor(work), broker),
      ),
    );
    expect(answers.map((answer) => answer.ok)).toEqual([false, false]);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
  expect(world.provider.seen.length).toBe(seen);
  expect((await asksOf(runId)).map((ask) => ask.ask_number)).toEqual([1]);
  expect(await stateOf(work, runId)).toMatchObject({ run: 'waiting_budget', reservation: 'held' });
});
