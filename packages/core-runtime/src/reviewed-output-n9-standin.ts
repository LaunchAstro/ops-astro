// SPDX-License-Identifier: AGPL-3.0-only
//
// STAND-IN, replaced at the join. AW-08 (branch b0/SL11-26-aw08a) owns
// `reviewed-output.ts` and migration 0213 `reviewed_outputs`; neither is on
// this base. AW-09 is built against AW-08's interface through this module,
// with the same three signatures. At the join every import of this file
// points at `./reviewed-output.ts` and this file is deleted.
//
// The behaviour here is made up, and says so:
//
// - `markReviewedOutput` writes nothing. AW-08's handback writes the mark;
//   this base's handback does not call it, and nothing in AW-09 marks.
// - `isReviewedOutput` answers from the version's own row instead of the
//   mark: a version proposed by an agent's actor counts. Every reviewed
//   output an agent produces is such a version (the handback's successor is
//   proposed as the agent), so AW-09's tests, which make their agent output
//   by a real handback with a successor, read the same under both modules.
//   AW-08's answer is narrower (a person's handback successor is marked too,
//   and an agent's plain proposal is not), which is why this is a stand-in.
// - `launchNotDecided` is AW-08's refusal; AW-09 never returns it, and the
//   code is not in this base's register, so this copy is not exported here.

import type { TenantQuery } from '../../core-records/src/index.ts';

export interface ReviewedOutputMark {
  /** The successor version the handback wrote. */
  readonly versionId: string;
  /** Its lineage, the one the handed-back work ran on. */
  readonly lineageId: string;
  /** The lease whose work the version hands back for review. */
  readonly leaseId: string;
}

/** STAND-IN: writes nothing (AW-08's handback writes the real mark). */
export async function markReviewedOutput(
  _tx: TenantQuery,
  _mark: ReviewedOutputMark,
): Promise<void> {
  await Promise.resolve();
}

/** STAND-IN: whether `versionId`, in the caller's business, was proposed by an agent's actor. */
export async function isReviewedOutput(tx: TenantQuery, versionId: string): Promise<boolean> {
  const rows = await tx.query<{ readonly marked: boolean }>(
    `select exists (
       select 1 from public.proposal_versions v
         join public.actors a
           on a.business_id = v.business_id and a.id = v.proposed_by_actor_id
        where v.business_id = $1 and v.id = $2 and a.kind = 'agent') as marked`,
    [tx.businessId, versionId],
  );
  return rows[0]?.marked === true;
}
