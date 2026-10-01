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
// When the spend used the whole hold nothing is left to hold, and the run
// stops at its budget and asks a person: the same ask a call reaching its
// ceiling raises (AW-05, `core-custody/src/broker-wait.ts`), with the ceiling
// and the spend the stopped hold carried, never a refusal nothing answers.

import type { TenantQuery } from '../../core-records/src/index.ts';
import { raiseBudgetWait, stopWords } from '../../core-custody/src/index.ts';

export interface Remaining {
  readonly heldMinor: number;
  readonly spentMinor: number;
  /** The hold less the spend it settled at: what a fresh hold for the step holds. */
  readonly leftMinor: number;
  readonly leaseId: string | null;
}

/** The stopped hold's figures, read under the caller's reservation lock. */
export async function remainingOf(tx: TenantQuery, reservationId: string): Promise<Remaining> {
  const [row] = await tx.query<{ held: string; spent: string; lease_id: string | null }>(
    `select held_minor::text as held,
            (case when state = 'actual' then actual_minor else 0 end)::text as spent, lease_id
       from public.reservations where business_id = $1 and id = $2`,
    [tx.businessId, reservationId],
  );
  if (row === undefined) throw new Error(`reservation ${reservationId}: no hold to replace`);
  const [heldMinor, spentMinor] = [Number(row.held), Number(row.spent)];
  return { heldMinor, spentMinor, leftMinor: heldMinor - spentMinor, leaseId: row.lease_id };
}

/**
 * The run stops at its budget and asks (AW-05). Under the caller's locks on
 * the run, the stopped hold's lease and its reservation. A run put back to
 * `planned` is claimed for the stop, which 0193 enters from `claimed` only,
 * and put back again when its asks are spent. Returns the words for the
 * refusal or the resume's note.
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
  const planned = await tx.query(
    `update public.planned_runs set state = 'claimed'
      where business_id = $1 and id = $2 and state = 'planned' returning id`,
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
  if (!wait.raised && planned.length > 0) {
    await tx.query(
      `update public.planned_runs set state = 'planned' where business_id = $1 and id = $2`,
      [tx.businessId, stop.runId],
    );
  }
  return stopWords(wait);
}
