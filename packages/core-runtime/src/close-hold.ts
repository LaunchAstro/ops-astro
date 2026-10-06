// SPDX-License-Identifier: AGPL-3.0-only
//
// Closing a held reservation, as the classifier, a write-off and a recorded outcome do. Kept
// out of recovery/classifier.ts so the classifier stays under its 600-line limit.

import type { TenantQuery } from '../../core-records/src/index.ts';

/**
 * Close a held reservation, guarded on `held` (false if another closed it): `actual` at
 * its model calls' cost, else abandoned under the cause (0013: an actual is never zero).
 * The envelope gives the hold back once and takes only that spend, never an invented zero.
 * A hold the classifier `stopped` records its cause on `actual` too (20261004040100); a person's
 * write-off or recorded outcome that settles it records none, as before.
 */
export async function closeHold(
  tx: TenantQuery,
  hold: { readonly reservationId: string; readonly envelopeId: string },
  cause: { readonly cause: string; readonly causeId: string },
  spentMinor: bigint,
  { stopped = false }: { readonly stopped?: boolean } = {},
): Promise<boolean> {
  const spent = spentMinor > 0n;
  const recorded = !spent || stopped;
  const [changed] = await tx.query<{ readonly held_minor: string }>(
    `update public.reservations
        set state = $3, actual_minor = $4, classified_cause = $5, classified_cause_id = $6,
            terminal_at = now()
      where business_id = $1 and id = $2 and state = 'held'
      returning held_minor::text as held_minor`,
    [
      tx.businessId,
      hold.reservationId,
      spent ? 'actual' : 'abandoned',
      spent ? spentMinor.toString() : null,
      recorded ? cause.cause : null,
      recorded ? cause.causeId : null,
    ],
  );
  if (changed === undefined) return false;
  await tx.query(
    `update public.task_envelopes set held_minor = held_minor - $3, actual_minor = actual_minor + $4
      where business_id = $1 and id = $2`,
    [tx.businessId, hold.envelopeId, changed.held_minor, spentMinor.toString()],
  );
  return true;
}
