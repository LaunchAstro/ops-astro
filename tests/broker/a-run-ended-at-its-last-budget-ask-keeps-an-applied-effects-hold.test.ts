// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05: the end at a run's last budget ask gives back only a hold whose
// attempts are all closed. Here the step's synthetic effect is dispatched and
// applied through production commands and one model call settles, but the
// effect is not yet observed: its price is unresolved, so the stop keeps the
// whole hold for that observation, as it does for a cost already unknown.
// Copied from Sol's review of #1413 (S1413-2, criterion 5).

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { callModel } from '../../packages/core-custody/src/index.ts';
import type { Work } from '../runtime/schedules-harness.ts';
import { broker, noDatabase, requestFor, s, stepOf, useBrokerWorld } from './broker-world.ts';
import { dispatchedWithOneCall } from './observed-hold-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;
useBrokerWorld('lastaskapplied');

/** The run's three asks, the last the consolidated decision, raised before this call. */
async function lastAsk(work: Work, ceiling: number): Promise<void> {
  await stepOf(work);
  for (let n = 1; n <= 3; n++) {
    // One ask at a time, each numbered after the last.
    // eslint-disable-next-line no-await-in-loop
    await s.db.admin.execute(
      `insert into public.budget_asks
      (business_id,id,run_id,reservation_id,lease_id,decision_id,ask_number,kind,ceiling_minor,spent_minor,currency)
      select $1,$2,r.run_id,r.id,$3,$4,$5,$6,$7,0,'AUD' from public.reservations r where r.id=$8`,
      [
        s.business,
        randomUUID(),
        work.picked['leaseId'],
        work.decision['decisionId'],
        n,
        n === 3 ? 'consolidated' : 'stop',
        ceiling,
        work.decision['reservationId'],
      ],
    );
  }
}

it('the final stop keeps the hold of an applied effect awaiting observation', async () => {
  const { w } = await dispatchedWithOneCall(true);
  const [row] = await s.db.admin.execute<{ reservation_id: string; decision_id: string }>(
    `select r.id as reservation_id,d.id as decision_id from public.leases l
      join public.reservations r on r.id=l.reservation_id
      join public.gate_decisions d on d.version_id=r.version_id and d.decision='approve'
      where l.id=$1 order by d.seq desc limit 1`,
    [w.picked['leaseId']],
  );
  if (!row) throw new Error('missing approved work');
  const work: Work = {
    ...w,
    proposal: {},
    decision: { reservationId: row.reservation_id, decisionId: row.decision_id },
  };
  await lastAsk(work, 500);
  const result = await callModel(
    s.db.app,
    s.business,
    { actorId: s.decider.actorId, delegationId: null, attendedByPersonId: s.decider.personId },
    requestFor(work),
    broker,
  );
  expect(result).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE' });
  const [money] = await s.db.admin.execute(
    `select run.state as run,r.state as reservation,
    e.held_minor::int as held,e.actual_minor::int as actual
    from public.reservations r join public.planned_runs run on run.id=r.run_id
    join public.task_envelopes e on e.id=r.envelope_id where r.id=$1`,
    [row.reservation_id],
  );
  expect(money).toEqual({ run: 'cancelled', reservation: 'held', held: 500, actual: 0 });
}, 60_000);
