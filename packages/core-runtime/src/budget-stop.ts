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
import { COUNTED_CAUSES, countedHold } from '../../core-custody/src/broker-give-back.ts';
import { raiseAlert } from './alerts.ts';

/**
 * SQL: the reservation `r`'s calls as they stand, as `spentOn` counts them
 * (settled at their actual, still open or unknown at their maximum). `r` is a
 * query's own alias.
 */
export const callsSpentOf = (r: string): string =>
  `(select coalesce(sum(case when c.state = 'settled' then c.actual_minor
                             when c.state in ('reserved', 'dispatched', 'liability_unknown')
                               then c.reserved_minor
                             else 0 end), 0)
      from public.model_calls c
     where c.business_id = ${r}.business_id and c.reservation_id = ${r}.id)`;

/** SQL: what the classifier's settle of `r` counts now, never above the figure it settled at. */
export const spentNowOf = (r: string): string => `least(${r}.actual_minor, ${callsSpentOf(r)})`;

/**
 * Before a top-up's answer marks a closed stopped hold counted (`countedHold`),
 * its calls never sent on an ended lease, which no count took, are released
 * uncounted, so the sweep gives nothing back for them. Under the answer's locks.
 */
export async function releaseUncounted(tx: TenantQuery, reservationId: string): Promise<void> {
  await tx.query(
    `update public.model_calls c set state = 'released', ended_at = clock_timestamp()
       from public.reservations r, public.leases l
      where c.business_id = $1 and c.reservation_id = $2 and c.state = 'reserved'
        and r.business_id = c.business_id and r.id = c.reservation_id
        and l.business_id = c.business_id and l.id = c.lease_id
        and (l.state <> 'live' or l.expires_at <= clock_timestamp())
        and not ${countedHold('$3')}`,
    [tx.businessId, reservationId, COUNTED_CAUSES],
  );
}

/**
 * The closed hold `r` has a call sent and never resolved that no top-up counts
 * again: a person's write-off or outcome closed it, or the hold is not counted
 * (custody's `countedHold`, reused), so it was open when a person closed the hold.
 */
export async function openCallOn(tx: TenantQuery, r: { reservation_id: string }): Promise<boolean> {
  const open = await tx.query(
    `select 1 from public.model_calls c join public.reservations r
         on r.business_id = c.business_id and r.id = c.reservation_id
      where c.business_id = $1 and c.reservation_id = $2
        and c.state in ('dispatched', 'liability_unknown')
        and (c.outcome is not null or not ${countedHold('$3')})`,
    [tx.businessId, r.reservation_id, COUNTED_CAUSES],
  );
  return open.length > 0;
}

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
