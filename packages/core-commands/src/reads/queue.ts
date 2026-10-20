// SPDX-License-Identifier: AGPL-3.0-only
//
// The work a person approved and nobody has picked up (I12).
//
// It is the runtime's `queue` and nothing else: the projection of approved,
// held, unleased reservations whose lineage is live, whose version is not
// superseded and whose attempt carries neither a dispatch marker nor an
// observation. That last exclusion is the one worth naming. T5 quarantines
// such an attempt with its hold retained, and handing a quarantined attempt to
// a worker as ordinary work would be offering somebody else's liability as a
// job.
//
// **Reading the queue claims nothing.** Two workers reading it see the same
// row, and the claim is `task.pickup`, which takes the reservation under the
// locks and refuses `RESERVATION_NOT_CLAIMABLE` to whichever of them is second.
// A read that reserved would be a read that changes the world, and every rule
// in `reads/requests.ts` about reads rests on it not doing that.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import { queue } from '../../../core-runtime/src/index.ts';
import type { QueuedWork } from '../../../core-wire/src/index.ts';

/**
 * The versions among `versionIds` the owner started: proposed by a person then
 * holding the owner role and approved only by such people, the two stamps the
 * plan route reads (`OWNER_RAN`, #1620 P4). Each is written as its row is
 * inserted and never changed (#1909), so reading them after the queue reads
 * the same answer.
 */
async function ownersOf(tx: TenantQuery, versionIds: readonly string[]): Promise<Set<string>> {
  const rows = await tx.query<{ readonly id: string }>(
    `select v.id::text from public.proposal_versions v
      where v.business_id = $1 and v.id = any($2::uuid[]) and v.proposed_by_owner is true
        and exists (select 1 from public.gate_decisions d
              where d.business_id = v.business_id and d.version_id = v.id
                and d.decision = 'approve')
        and not exists (select 1 from public.gate_decisions d
              where d.business_id = v.business_id and d.version_id = v.id
                and d.decision = 'approve' and d.decided_by_owner is not true)`,
    [tx.businessId, versionIds],
  );
  return new Set(rows.map((row) => row.id));
}

/**
 * `agentActorId` is an agent's own read, narrowed under its live delegations
 * (`queue`). The proposer is named only on the reader's own proposals: work
 * another actor proposed shows as ids, purpose and amount, never who proposed
 * it, and a person's read names no proposer at all. Whether the owner
 * proposed and approved it is said to every reader, as the owner's role and
 * never the person: a worker also works the owner's own plan on its
 * delegation's task.
 */
export async function readQueue(
  tx: TenantQuery,
  agentActorId?: string,
): Promise<readonly QueuedWork[]> {
  const entries = await queue(tx, agentActorId);
  const owners = await ownersOf(
    tx,
    entries.map((entry) => entry.versionId),
  );
  return entries.map((entry) => ({
    reservationId: entry.reservationId,
    taskId: entry.taskId,
    runId: entry.runId,
    versionId: entry.versionId,
    lineageId: entry.lineageId,
    purpose: entry.purpose,
    heldMinor: entry.heldMinor,
    proposedByActorId:
      agentActorId !== undefined && entry.proposedByActorId === agentActorId
        ? entry.proposedByActorId
        : null,
    ownerProposed: owners.has(entry.versionId),
  }));
}
