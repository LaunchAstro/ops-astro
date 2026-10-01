// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08: the reviewed output, and the one accept that releases an effect.
//
// Accepting the plan lets the agent work; it fires nothing. The agent hands
// its output back with a successor version (T4's handback), and that version
// is the reviewed output. Its accept is the launch, and dispatch releases an
// effect only for a version marked here (`0213_reviewed_outputs`).
//
// The mark is written by the handback, in the transaction that writes the
// successor, under the handback's locks, naming the lease whose work produced
// it. It is never rewritten, so a version is a reviewed output from the moment
// it exists or never. Both calls run in the caller's tenant transaction; row
// security keeps them to that business, and the trigger checks the version and
// the lease's work are on the lineage the mark names.

import type { TenantQuery } from '../../core-records/src/index.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

export interface ReviewedOutputMark {
  /** The successor version the handback wrote. */
  readonly versionId: string;
  /** Its lineage, the one the handed-back work ran on. */
  readonly lineageId: string;
  /** The lease whose work the version hands back for review. */
  readonly leaseId: string;
}

/** Mark `versionId` as a reviewed output. A second mark of one version throws. */
export async function markReviewedOutput(tx: TenantQuery, mark: ReviewedOutputMark): Promise<void> {
  await tx.query(
    `insert into public.reviewed_outputs (business_id, version_id, lineage_id, lease_id)
     values ($1, $2, $3, $4)`,
    [tx.businessId, mark.versionId, mark.lineageId, mark.leaseId],
  );
}

/** Whether `versionId`, in the caller's business, is a reviewed output. */
export async function isReviewedOutput(tx: TenantQuery, versionId: string): Promise<boolean> {
  const rows = await tx.query<{ readonly marked: boolean }>(
    `select exists (select 1 from public.reviewed_outputs
                     where business_id = $1 and version_id = $2) as marked`,
    [tx.businessId, versionId],
  );
  return rows[0]?.marked === true;
}

/** The refusal for an effect whose approval is not the launch of a reviewed output. */
export function launchNotDecided(): RuntimeResult<never> {
  return refuse(
    'LAUNCH_NOT_DECIDED',
    'this work was approved as a plan; only accepting its reviewed output releases the effect',
    'Nothing was dispatched. Hand the output back for review; accepting it is the launch.',
  );
}
