// SPDX-License-Identifier: AGPL-3.0-only
//
// Who may spend on a lease: its holder, or a helper under a child of its
// delegation (AW-11). Read by the reserve's and the settle's lease locks.

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
