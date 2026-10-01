// SPDX-License-Identifier: AGPL-3.0-only
//
// What a stopped step's hold leaves it (SL11-29 FIXMONEY).
//
// A hold the classifier settled at its broker calls' spend
// (`recovery/classifier.ts`) is history, and the step comes back on a fresh
// hold: pickup's replacement (`pickup.ts`) or a drop's resume
// (`recovery/reconcile.ts`). That hold is the old one less the spend it
// settled at, the step's budget that remains, so the envelope that counted the
// spend has room for it. A hold settled at nothing, or still held, leaves its
// whole amount.
//
// The spend is counted from the hold's calls as they stand now: the
// classifier counted a call still open at its maximum, and when that call
// ends lower the envelope gets the difference back (`giveBack`,
// `core-custody/src/broker-give-back.ts`), so the step has that room again.
//
// When the spend used the whole hold nothing is left to hold, and the run
// stops at its budget and asks a person: the same ask a call reaching its
// ceiling raises (AW-05, `core-custody/src/broker-wait.ts`), with the ceiling
// and the spend the stopped hold carried, never a refusal nothing answers.
// After the consolidated ask there is no other to raise: the run ends there
// and a person is told on the task.

import type { TenantQuery } from '../../core-records/src/index.ts';
import { raiseBudgetWait, stopWords } from '../../core-custody/src/index.ts';
import { raiseAlert } from './alerts.ts';

/**
 * SQL: what the classifier's settle of the reservation `r` counts now, its
 * calls as they stand (settled at their actual, still open or unknown at their
 * maximum), never above the figure it settled at. `r` is a query's own alias.
 * A call released unsent after the settle (never started, ended after it)
 * was counted at its maximum and gives nothing back, so it stays there, as the
 * envelope counts it; the cap keeps one the settle already counted at nothing
 * (released by the sweep in the settle's own transaction) from adding to it.
 */
export const spentNowOf = (r: string): string =>
  `least(${r}.actual_minor, (
     select coalesce(sum(case when c.state = 'settled' then c.actual_minor
                              when c.state in ('reserved', 'dispatched', 'liability_unknown')
                                then c.reserved_minor
                              when c.state = 'released' and c.started_at is null
                                   and c.ended_at > ${r}.terminal_at then c.reserved_minor
                              else 0 end), 0)
       from public.model_calls c
      where c.business_id = ${r}.business_id and c.reservation_id = ${r}.id))`;

/**
 * The reservation's spend to date, as the broker counts it
 * (`core-custody/src/broker-facts.ts`, `committedMinor`): settled calls at
 * their actual, and calls still open at the maximum they hold, so a call in
 * flight at the stop is never released as unspent.
 */
export async function spentOn(tx: TenantQuery, reservationId: string): Promise<number> {
  const [row] = await tx.query<{ readonly spent: string }>(
    `select coalesce(sum(case when state = 'settled' then actual_minor
                              when state in ('reserved', 'dispatched', 'liability_unknown')
                                then reserved_minor
                              else 0 end), 0)::text as spent
       from public.model_calls where business_id = $1 and reservation_id = $2`,
    [tx.businessId, reservationId],
  );
  return Number(row?.spent ?? 0);
}

export interface Remaining {
  readonly heldMinor: number;
  readonly spentMinor: number;
  /** The hold less its calls' spend as it stands: what a fresh hold for the step holds. */
  readonly leftMinor: number;
  readonly leaseId: string | null;
}

/** The stopped hold's figures, read under the caller's reservation lock. */
export async function remainingOf(tx: TenantQuery, reservationId: string): Promise<Remaining> {
  // Only the classifier's settle counts its calls' spend: an observed or written-off
  // cost (its attempt `settled`) closed the step's work, which a person reopens whole.
  const [row] = await tx.query<{ held: string; spent: string; lease_id: string | null }>(
    `select r.held_minor::text as held, r.lease_id,
            (case when r.state = 'actual' and a.state <> 'settled' then ${spentNowOf('r')}
                  else 0 end)::text as spent
       from public.reservations r
       join public.attempts a on a.business_id = r.business_id and a.reservation_id = r.id
      where r.business_id = $1 and r.id = $2`,
    [tx.businessId, reservationId],
  );
  if (row === undefined) throw new Error(`reservation ${reservationId}: no hold to replace`);
  const [heldMinor, spentMinor] = [Number(row.held), Number(row.spent)];
  return { heldMinor, spentMinor, leftMinor: heldMinor - spentMinor, leaseId: row.lease_id };
}

/**
 * The run stops at its budget and asks (AW-05). Under the caller's locks on
 * the run, the stopped hold's lease and its reservation. A run put back to
 * `planned` is claimed for the stop, which 0193 enters from `claimed` only.
 * When its asks are spent the run ends, as a person's end does, with no hold
 * left to release, and a person is told on the task. Returns the words for
 * the refusal or the resume's note.
 */
export async function stopAtSpentHold(
  tx: TenantQuery,
  stop: {
    readonly runId: string;
    readonly reservationId: string;
    readonly versionId: string;
    readonly delegationId: string | null;
    readonly remaining: Remaining;
  },
): Promise<string> {
  const { leaseId, heldMinor, spentMinor } = stop.remaining;
  // A hold spends only through calls under its lease (AW-01), so a spent hold has one.
  if (leaseId === null) throw new Error('budget stop: a spent hold with no lease');
  await tx.query(
    `update public.planned_runs set state = 'claimed'
      where business_id = $1 and id = $2 and state = 'planned'`,
    [tx.businessId, stop.runId],
  );
  const wait = await raiseBudgetWait(tx, {
    runId: stop.runId,
    leaseId,
    delegationId: stop.delegationId,
    reservationId: stop.reservationId,
    versionId: stop.versionId,
    ceilingMinor: heldMinor,
    spentMinor,
  });
  if (wait.raised) return stopWords(wait);
  const [run] = await tx.query<{ readonly task_id: string }>(
    `update public.planned_runs set state = 'cancelled'
      where business_id = $1 and id = $2 returning task_id`,
    [tx.businessId, stop.runId],
  );
  if (run === undefined) throw new Error('budget stop: the stopped run is gone');
  await raiseAlert(tx, {
    taskId: run.task_id,
    causeId: stop.reservationId,
    raised: { kind: 'awaiting_person', waitingReason: 'needs_approval' },
  });
  return LAST_ASK_SPENT;
}

const LAST_ASK_SPENT =
  "The consolidated decision was this run's last ask, so the run ends here and a person is told on the task.";
