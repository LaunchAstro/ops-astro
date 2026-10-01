// SPDX-License-Identifier: AGPL-3.0-only
//
// Who may spend on a lease: its holder, or a helper under a child of its
// delegation (AW-11). Read by the reserve's and the settle's lease locks. And
// whether the lease's attempt may call again at all (AW-12 A7).

import type { TenantQuery } from '../../core-records/src/index.ts';
import type { ModelCaller } from './broker-types.ts';

/**
 * The lease's holder under its delegation, or a helper holding a live child
 * of that delegation (AW-11). A child spends on its parent's lease, at its
 * fence, against its reservation: the one path and the one ceiling, never a
 * second ledger. The child is read, not locked; the parent's delegation is
 * locked next, and the agent entry has already walked the child to it.
 */
export async function holdsWork(
  tx: TenantQuery,
  caller: ModelCaller,
  lease: { readonly holder_actor_id: string; readonly delegation_id: string | null },
): Promise<boolean> {
  if (lease.holder_actor_id === caller.actorId && lease.delegation_id === caller.delegationId) {
    return true;
  }
  if (lease.delegation_id === null || caller.delegationId === null) return false;
  const children = await tx.query<{ id: string }>(
    `select id from public.delegations
      where business_id = $1 and id = $2 and agent_actor_id = $3 and parent_delegation_id = $4
        and revoked_at is null and settled_at is null and expires_at > clock_timestamp()`,
    [tx.businessId, caller.delegationId, caller.actorId, lease.delegation_id],
  );
  return children.length === 1;
}

/**
 * Whether a call of the reservation's attempt failed and is held as unknown
 * liability, a drop (AW-10). It may have acted, so the attempt takes no other
 * call: a framework's own retry is refused at the reserve, a call held before
 * the drop is released at its start, and the retry is the product's, a new
 * attempt once the work is handed back and the pass proves nothing happened.
 * An answer above its hold is no drop: the run calls on.
 */
export async function heldUnknown(tx: TenantQuery, reservationId: string): Promise<boolean> {
  const found = await tx.query(
    `select 1 from public.model_calls
      where business_id = $1 and reservation_id = $2 and state = 'liability_unknown'
        and drop_state is not null
      limit 1`,
    [tx.businessId, reservationId],
  );
  return found.length > 0;
}
