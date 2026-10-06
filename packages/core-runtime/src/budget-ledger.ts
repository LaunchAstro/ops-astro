// SPDX-License-Identifier: AGPL-3.0-only
//
// The ledger's one rule for what closing a held reservation gives back (RUNTIME.md, "The model
// call's ledger"). A hold whose attempt is marked, or that has a model call sent and never
// settled, gives back nothing: it stays whole for a person. Any other hold closes at what its
// settled calls cost, and the rest goes back. The classifier closes holds this way
// (`classifyUnderLocks`), and proposal preflight predicts room by it (#836).

import type { TenantQuery } from '../../core-records/src/index.ts';
import { modelCallsOn } from './model-calls-on.ts';

/** What closing the held reservations of `versionIds` gives back, in all and in one envelope. */
export interface Released {
  readonly released: bigint;
  readonly fromEnvelope: bigint;
}

/**
 * Under the caller's locks on those holds: what closing every held reservation of these
 * versions gives back, and how much of that comes back to `envelopeId`.
 */
export async function releasedOnClosing(
  tx: TenantQuery,
  versionIds: readonly string[],
  envelopeId: string | null,
): Promise<Released> {
  if (versionIds.length === 0) return { released: 0n, fromEnvelope: 0n };
  const holds = await tx.query<{
    readonly id: string;
    readonly envelope_id: string;
    readonly held_minor: string;
    readonly marked: boolean;
  }>(
    `select res.id, res.envelope_id, res.held_minor::text as held_minor,
            (att.dispatch_marker or att.observed) as marked
       from public.reservations res
       join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
      where res.business_id = $1 and res.state = 'held' and res.version_id = any($2::uuid[])
      order by res.id`,
    [tx.businessId, versionIds],
  );
  let released = 0n;
  let fromEnvelope = 0n;
  for (const hold of holds) {
    // One hold at a time, each read under the caller's locks.
    // eslint-disable-next-line no-await-in-loop
    const back = await givesBack(tx, hold);
    released += back;
    if (hold.envelope_id === envelopeId) fromEnvelope += back;
  }
  return { released, fromEnvelope };
}

async function givesBack(
  tx: TenantQuery,
  hold: { readonly id: string; readonly held_minor: string; readonly marked: boolean },
): Promise<bigint> {
  if (hold.marked) return 0n;
  const calls = await modelCallsOn(tx, hold.id);
  return calls.open ? 0n : BigInt(hold.held_minor) - calls.spentMinor;
}
