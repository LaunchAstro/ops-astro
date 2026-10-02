// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08: the reviewed output, and the one accept that releases an effect.
//
// Accepting the plan lets the agent work; it fires nothing. The agent hands
// its output back with a successor version (T4's handback), and that version
// is the reviewed output. Its accept is the launch, and dispatch releases an
// effect only for a version marked here (`0108_reviewed_outputs`).
//
// The mark is written by the handback, in the transaction that writes the
// successor, under the handback's locks, naming the lease whose work produced
// it. The agent's revision of its output (a proposal on the lineage after
// requested changes) is its output too, so `propose` marks it under the same
// lease (AW-09). A mark is never rewritten, so a version is a reviewed output
// from the moment it exists or never. The calls run in the caller's tenant
// transaction; row security keeps them to that business, and the trigger checks
// the version and the lease's work are on the lineage the mark names, and the
// lease's holder proposed the version (0111). The two
// callers mark only the lease's own work: the handback the successor it has
// just written, `propose` a revision its lease holder proposed. A person's
// newer version on the agent's lineage is never the agent's output; the
// agent's revision after it is, under the lineage's newest mark.

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

/**
 * AW-09: the revision `versionId` supersedes `supersededId`. When the
 * lineage's newest reviewed output is its lease holder's, and the revision is
 * that holder's own, the revision is the reviewed output now, under the same
 * lease; a person's revision is not, and does not end the agent's line.
 */
export async function markRevision(
  tx: TenantQuery,
  versionId: string,
  supersededId: string,
): Promise<void> {
  const [found] = await tx.query<{ readonly lineage_id: string; readonly lease_id: string }>(
    `select ro.lineage_id, ro.lease_id
       from (select ro.* from public.proposal_versions old
               join public.reviewed_outputs ro on ro.business_id = old.business_id
                                              and ro.lineage_id = old.lineage_id
               join public.proposal_versions marked on marked.business_id = ro.business_id
                                                    and marked.id = ro.version_id
              where old.business_id = $1 and old.id = $2
              order by marked.version desc limit 1) ro
       join public.leases l on l.business_id = ro.business_id and l.id = ro.lease_id
       join public.proposal_versions v on v.business_id = ro.business_id and v.id = $3
      where v.proposed_by_actor_id = l.holder_actor_id`,
    [tx.businessId, supersededId, versionId],
  );
  if (found === undefined) return;
  await markReviewedOutput(tx, { versionId, lineageId: found.lineage_id, leaseId: found.lease_id });
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
