// SPDX-License-Identifier: AGPL-3.0-only
//
// The work a person approved and nobody has picked up (I12).
//
// It is L4's `queue` and nothing else: the projection of approved, held,
// unleased reservations whose lineage is live, whose version is not superseded
// and whose attempt carries neither a dispatch marker nor an observation. That
// last exclusion is the one worth naming — T5 quarantines such an attempt with
// its hold retained, and handing a quarantined attempt to a worker as ordinary
// work would be offering somebody else's liability as a job.
//
// **Reading the queue claims nothing.** Two workers reading it see the same
// row, and the claim is `task.pickup`, which takes the reservation under the
// locks and refuses `RESERVATION_NOT_CLAIMABLE` to whichever of them is second.
// A read that reserved would be a read that changes the world, and every rule
// in `reads/requests.ts` about reads rests on it not doing that.

import type { TenantQuery } from '../tenancy/database.ts';
import { queue } from '../../../core-runtime/src/index.ts';

export interface QueuedWork {
  readonly reservationId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly versionId: string;
  readonly lineageId: string;
  readonly purpose: string;
  readonly heldMinor: number;
}

export async function readQueue(tx: TenantQuery): Promise<readonly QueuedWork[]> {
  const entries = await queue(tx);
  return entries.map((entry) => ({
    reservationId: entry.reservationId,
    taskId: entry.taskId,
    runId: entry.runId,
    versionId: entry.versionId,
    lineageId: entry.lineageId,
    purpose: entry.purpose,
    heldMinor: entry.heldMinor,
  }));
}
