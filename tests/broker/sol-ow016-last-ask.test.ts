// SPDX-License-Identifier: AGPL-3.0-only
//
// #438 (OW-016.4, S2 of the engine sweep): one budget-exhaustion transition.
// After the run's three asks, the third the consolidated decision, a call the
// reservation cannot hold raises no fourth ask. The broker's wait path and the
// pickup stop path both end the run there through the one stop operation
// (`core-custody/src/broker-wait.ts`, `stopAtBudget`): the lease over, the
// delegation retired, the run cancelled and a person told on the task. Before
// the fix the broker returned with nothing written, leaving the run claimed on
// a live lease with no alert.
//
// After the end (TEST.md M2 and M9): nothing spends, no machine path asks
// again, and restart recovery settles the hold at its calls' spend, never at
// nothing, while the run stays ended.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { replayRecordedTransitions } from '../../packages/core-runtime/src/index.ts';
import { codeOf, liveWork, rows, type Work } from '../runtime/schedules-harness.ts';
import { pickupOf, spentWhole } from '../runtime/resume-sizing-world.ts';
import { call, noDatabase, s, useBrokerWorld, world } from './broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('ow016last');

/** The replay operation's priced maximum is 500 minor units: a 400 ceiling cannot hold one call. */
const UNDER_ONE_CALL = 400;

/** The run's three asks, raised and answered already: the third is the consolidated decision. */
const asksSpent = async (work: Work): Promise<void> => {
  for (const at of [1, 2, 3]) {
    // eslint-disable-next-line no-await-in-loop
    await rows(
      s,
      `insert into public.budget_asks
         (business_id, id, run_id, reservation_id, lease_id, decision_id, ask_number, kind,
          ceiling_minor, spent_minor, currency)
       select r.business_id, $2, r.run_id, r.id, $3, d.id, $4, $5, r.held_minor, 0, 'AUD'
         from public.reservations r
         join public.gate_decisions d on d.business_id = r.business_id and d.version_id = r.version_id
        where r.id = $1 and d.decision = 'approve'`,
      [
        work.decision['reservationId'],
        randomUUID(),
        work.picked['leaseId'],
        at,
        at === 3 ? 'consolidated' : 'stop',
      ],
    );
  }
};

/** What the run's end left: the same record whichever path saw the final unanswered ask. */
const endOf = async (work: Work) => {
  const [run] = await rows<{ run: string; live_leases: number; live_delegations: number }>(
    s,
    `select run.state as run,
            (select count(*)::int from public.leases l
              where l.run_id = run.id and l.state = 'live') as live_leases,
            (select count(*)::int from public.leases l
               join public.delegations d on d.id = l.delegation_id
              where l.run_id = run.id and d.revoked_at is null) as live_delegations
       from public.planned_runs run
       join public.reservations r on r.run_id = run.id
      where r.id = $1`,
    [work.decision['reservationId']],
  );
  const alerts = await rows<{ kind: string; waiting_reason: string; cause: string }>(
    s,
    `select kind, waiting_reason, cause_id::text as cause from public.alerts
      where task_id = $1 order by raised_at, id`,
    [work.taskId],
  );
  const [asks] = await rows<{ n: number }>(
    s,
    `select count(*)::int as n from public.budget_asks k
       join public.reservations r on r.run_id = k.run_id
      where r.id = $1`,
    [work.decision['reservationId']],
  );
  return {
    ...run,
    alerts: alerts.map(({ kind, waiting_reason, cause }) => ({
      kind,
      waiting_reason,
      cause: cause === work.decision['reservationId'] ? 'the stopped hold' : cause,
    })),
    asks: asks?.n,
  };
};

const ENDED = {
  run: 'cancelled',
  live_leases: 0,
  live_delegations: 0,
  alerts: [
    { kind: 'awaiting_person', waiting_reason: 'needs_approval', cause: 'the stopped hold' },
  ],
  asks: 3,
};

it('Sol proof, criterion 1: a broker budget stop after the third ask ends the run and alerts a person', async () => {
  const work = await liveWork(s, `ow016 broker ${randomUUID()}`, UNDER_ONE_CALL);
  await asksSpent(work);
  world.provider.mode('answer');
  const seen = world.provider.seen.length;

  const result = await call(work);

  expect(result.ok ? null : result.code).toBe('BUDGET_UNAVAILABLE');
  expect(world.provider.seen.length).toBe(seen);
  expect(await endOf(work)).toEqual(ENDED);
});

it('the broker and pickup end a run past its last ask with the same record and alert', async () => {
  const atCall = await liveWork(s, `ow016 both broker ${randomUUID()}`, UNDER_ONE_CALL);
  await asksSpent(atCall);
  const byBroker = await call(atCall);

  const atPickup = await spentWhole(`ow016 both pickup ${randomUUID()}`);
  await asksSpent(atPickup);
  const byPickup = await pickupOf(atPickup);

  expect(byBroker.ok ? null : byBroker.code).toBe('BUDGET_UNAVAILABLE');
  expect(codeOf(byPickup)).toBe('BUDGET_UNAVAILABLE');
  expect(await endOf(atCall)).toEqual(ENDED);
  expect(await endOf(atPickup)).toEqual(ENDED);
  // Both say the same: the run ended at its last ask, and a person is told.
  const words = 'words' in byBroker ? byBroker.words : null;
  expect(words).toBeTruthy();
  expect(JSON.stringify(byPickup)).toContain(JSON.stringify(words).slice(1, -1));
});

it('M2 and M9 after the final ask: nothing spends, no fourth ask, and recovery settles the hold at its spend', async () => {
  const work = await liveWork(s, `ow016 after ${randomUUID()}`, UNDER_ONE_CALL);
  await asksSpent(work);
  await call(work);
  const seen = world.provider.seen.length;

  // Another call on the ended run refuses and sends nothing.
  const again = await call(work);
  expect(again.ok).toBe(false);
  expect(world.provider.seen.length).toBe(seen);

  // Restart recovery finds the hold of a run that ended with its lease over
  // and its delegation retired, and settles it at what its calls spent (none
  // here); the run stays ended, with no fourth ask and no second alert.
  await s.db.app.withBusiness(s.business, async (tx) => await replayRecordedTransitions(tx));
  expect(await endOf(work)).toEqual(ENDED);
  const [hold] = await rows<{ state: string; actual: string | null }>(
    s,
    `select state, actual_minor::text as actual from public.reservations where id = $1`,
    [work.decision['reservationId']],
  );
  expect(hold).toEqual({ state: 'actual', actual: '0' });
});
