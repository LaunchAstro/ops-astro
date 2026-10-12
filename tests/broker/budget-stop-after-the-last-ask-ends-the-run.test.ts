// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05: a run asks three times at most, the third the consolidated decision.
// A call past the ceiling after that asks no fourth time: the run ends, its
// lease and delegation end with it, and a person is told on the task, so the
// run is never left claimed with nothing to answer.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { liveWork } from '../runtime/schedules-harness.ts';
import { call, noDatabase, s, useBrokerWorld, world } from './broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('lastask');

/** Under the replay operation's priced maximum of 500: no call fits. */
const UNDER_ONE_CALL = 400;

/** The run's three asks, answered before this lease was given out. */
async function askedThreeTimes(leaseId: unknown, reservationId: unknown, decisionId: unknown) {
  const [run] = await s.db.admin.execute<{ run_id: string }>(
    'select run_id from public.leases where id = $1',
    [leaseId],
  );
  for (const [askNumber, kind] of [
    [1, 'stop'],
    [2, 'stop'],
    [3, 'consolidated'],
  ] as const) {
    // One ask at a time, each numbered after the last.
    // eslint-disable-next-line no-await-in-loop
    await s.db.admin.execute(
      `insert into public.budget_asks
         (business_id, id, run_id, reservation_id, lease_id, decision_id, ask_number, kind,
          ceiling_minor, spent_minor, currency)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 400, 0, 'AUD')`,
      [s.business, randomUUID(), run?.run_id, reservationId, leaseId, decisionId, askNumber, kind],
    );
  }
}

/** The run, its lease and delegation, its asks and the alerts on its task, after the call. */
async function endOf(leaseId: unknown) {
  const [after] = await s.db.admin.execute(
    `select run.state as run, l.state as lease, d.revocation_cause as cause,
            (select count(*)::int from public.budget_asks k where k.run_id = run.id) as asks,
            (select json_agg(json_build_object('kind', a.kind, 'reason', a.waiting_reason))
               from public.alerts a where a.task_id = run.task_id and a.cause_id = l.reservation_id)
              as alerts
       from public.leases l
       join public.planned_runs run on run.id = l.run_id
       join public.delegations d on d.id = l.delegation_id
      where l.id = $1`,
    [leaseId],
  );
  return after;
}

it('a call past the ceiling after the third ask ends the run and tells a person', async () => {
  const work = await liveWork(s, 'last ask spent', UNDER_ONE_CALL);
  const leaseId = work.picked['leaseId'];
  const reservationId = work.decision['reservationId'];
  await askedThreeTimes(leaseId, reservationId, work.decision['decisionId']);
  world.provider.mode('answer');
  const seen = world.provider.seen.length;

  const result = await call(work);

  expect(result).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE' });
  expect(world.provider.seen.length).toBe(seen);
  const after = await endOf(leaseId);
  expect(after).toEqual({
    run: 'cancelled',
    lease: 'released',
    cause: 'work_retired',
    asks: 3,
    alerts: [{ kind: 'awaiting_person', reason: 'needs_approval' }],
  });
});
