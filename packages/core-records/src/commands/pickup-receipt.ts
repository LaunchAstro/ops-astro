// SPDX-License-Identifier: AGPL-3.0-only
//
// Whether a stored pickup receipt is still the caller's claim, which both
// entries ask before they replay one: the person envelope (`envelope.ts`) and
// the agent pickup replay (`agent-replay.ts`). Moved unchanged out of
// `tasks-pickup.ts`, which claims a reservation and never replays one
// (THERMO-FIX-AGENT N2).

import type { TenantQuery } from '../tenancy/database.ts';
import { isIdentifier } from './operands.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';

export const PICKUP_REPLAY_FIXES: readonly string[] = [
  'The work this pickup claimed is no longer yours to resume.',
  'Re-read the queue.',
];

/** Stands in for a receipt handle that is not an identifier, so it matches no row. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** A still-bound receipt's delegation credential columns: null on a person's pickup. */
export interface PickupReceiptBinding {
  readonly credential_scheme: string | null;
  readonly credential_key_id: string | null;
  readonly credential_hash: string | null;
}

/**
 * Whether a stored pickup receipt is still the caller's claim: one step for
 * the person envelope (`withheldNow`) and the agent pickup replay (step 3 of
 * `replayPickup`), in one statement and one refusal ladder
 * (THERMO-RECHECK-2 NNA2).
 *
 * The receipt's lease, hold and attempt are still bound to one another, to
 * `holderActorId`, to `delegationId` (`null` for a person's own lease, and
 * then the agent's delegation, whose agent must be the holder) and to the
 * receipt's task and version; the lease is live and unexpired, the hold
 * held, and the approval behind it current. A handle that is not an
 * identifier matches no row.
 */
export async function pickupReceiptBinding(
  tx: TenantQuery,
  replay: {
    readonly holderActorId: string;
    readonly delegationId: string | null;
    readonly receipt: Readonly<Record<string, unknown>>;
  },
): Promise<{ readonly refusal: CommandRefusal } | { readonly bound: PickupReceiptBinding }> {
  const named = (key: string): string => {
    const value = replay.receipt[key];
    return isIdentifier(value) ? value : NIL_UUID;
  };
  const rows = await tx.query<
    PickupReceiptBinding & { readonly lease_live: boolean; readonly approval_current: boolean }
  >(
    `select d.credential_scheme, d.credential_key_id, d.credential_hash,
            (l.state = 'live' and l.expires_at > now() and res.state = 'held') as lease_live,
            (g.state = 'approved' and lin.state = 'live' and ver.superseded_at is null)
              as approval_current
       from public.leases l
       left join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
       join public.reservations res on res.business_id = l.business_id and res.lease_id = l.id
       join public.attempts att
         on att.business_id = l.business_id and att.reservation_id = res.id and att.lease_id = l.id
       join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
       join public.proposal_versions ver
         on ver.business_id = res.business_id and ver.id = res.version_id
       join public.proposal_lineages lin
         on lin.business_id = res.business_id and lin.id = run.lineage_id
       join public.gates g on g.business_id = res.business_id and g.version_id = res.version_id
      where l.business_id = $1 and l.id = $2 and res.id = $3 and att.id = $4
        and l.holder_actor_id = $5 and l.delegation_id is not distinct from $6::uuid
        and (l.delegation_id is null or d.agent_actor_id = $5)
        and l.task_id = $7 and res.version_id = $8`,
    [
      tx.businessId,
      named('leaseId'),
      named('reservationId'),
      named('attemptId'),
      replay.holderActorId,
      replay.delegationId,
      named('taskId'),
      named('versionId'),
    ],
  );
  const bound = rows[0];
  if (bound === undefined)
    return { refusal: refuseCommand('LEASE_NOT_OWNED', [], PICKUP_REPLAY_FIXES) };
  if (!bound.lease_live)
    return { refusal: refuseCommand('LEASE_EXPIRED', [], PICKUP_REPLAY_FIXES) };
  if (!bound.approval_current) {
    return { refusal: refuseCommand('RESERVATION_NOT_CLAIMABLE', [], PICKUP_REPLAY_FIXES) };
  }
  const { lease_live: _live, approval_current: _current, ...credential } = bound;
  return { bound: credential };
}
