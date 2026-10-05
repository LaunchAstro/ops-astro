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
import { refuse, type RuntimeResult } from './refusals.ts';

/**
 * SQL: what the classifier's settle of the reservation `r` counts now, its
 * calls as they stand (settled at their actual, still open or unknown at their
 * maximum), never above the figure it settled at. `r` is a query's own alias.
 */
export const spentNowOf = (r: string): string =>
  `least(${r}.actual_minor, (
     select coalesce(sum(case when c.state = 'settled' then c.actual_minor
                              when c.state in ('reserved', 'dispatched', 'liability_unknown')
                                then c.reserved_minor
                              else 0 end), 0)
       from public.model_calls c
      where c.business_id = ${r}.business_id and c.reservation_id = ${r}.id))`;

/** A hold's spend to date, and the calls it counted while still unsent. */
export interface Spent {
  readonly spent: number;
  /** The `reserved` calls counted at their maximum, for `giveBackReleased`. */
  readonly unsent: readonly string[];
}

/**
 * The reservation's spend to date, as the broker counts it
 * (`core-custody/src/broker-facts.ts`, `committedMinor`): settled calls at
 * their actual, and calls still open at the maximum they hold, so a call in
 * flight at the stop is never released as unspent.
 */
export async function spentOn(tx: TenantQuery, reservationId: string): Promise<Spent> {
  const [row] = await tx.query<{ readonly spent: string; readonly unsent: string[] | null }>(
    `select coalesce(sum(case when state = 'settled' then actual_minor
                              when state in ('reserved', 'dispatched', 'liability_unknown')
                                then reserved_minor
                              else 0 end), 0)::text as spent,
            array_agg(id::text) filter (where state = 'reserved') as unsent
       from public.model_calls where business_id = $1 and reservation_id = $2`,
    [tx.businessId, reservationId],
  );
  return { spent: Number(row?.spent ?? 0), unsent: row?.unsent ?? [] };
}

/**
 * An attempt left `liability_unknown` on the held reservation has a cost nothing counts yet:
 * an observation or a failed report that kept the hold whole (`settleAtObserved`), or the
 * classifier's or a lost worker's open call. Ending the run, releasing the hold less its
 * calls, would hand that cost back to the cap as unspent. Read under the reservation lock;
 * the hold waits for a person's outcome.
 */
export async function observedRefusal(
  tx: TenantQuery,
  reservationState: string,
  reservationId: string,
): Promise<RuntimeResult<never> | null> {
  if (reservationState !== 'held') return null;
  const kept = await tx.query(
    `select 1 from public.attempts
      where business_id = $1 and reservation_id = $2 and state = 'liability_unknown'`,
    [tx.businessId, reservationId],
  );
  if (kept.length === 0) return null;
  return refuse(
    'TRANSITION_NOT_PERMITTED',
    "this step's cost is not resolved yet: it ran above the hold, " +
      'or a call on it is still open or was lost',
    'Record the step’s outcome first, then end the work.',
  );
}

/**
 * A step settled `completed` in any transaction but the ask's own (a person's `happened` or
 * `happened_differently`, a worker's observed `completed`): a top-up cannot apply; the end does.
 * Both stamps are now(), each its transaction's start, which can invert across transactions,
 * so only equal stamps mark a settle and ask in one transaction, which would still top up;
 * no path raises that today.
 */
export async function recordedRefusal(
  tx: TenantQuery,
  stop: { readonly reservation_id: string; readonly ask_id: string },
): Promise<RuntimeResult<never> | null> {
  const done = await tx.query(
    `select 1 from public.attempts a join public.budget_asks k on k.business_id = a.business_id
      where a.business_id = $1 and a.reservation_id = $2 and k.id = $3 and a.state = 'settled'
        and a.outcome = 'completed' and a.settled_at is distinct from k.raised_at`,
    [tx.businessId, stop.reservation_id, stop.ask_id],
  );
  if (done.length === 0) return null;
  const why = "this step's outcome was recorded after the run stopped, so a top-up cannot apply";
  return refuse('TRANSITION_NOT_PERMITTED', why, 'End the work instead.');
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
