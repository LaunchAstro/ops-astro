// SPDX-License-Identifier: AGPL-3.0-only
//
// A live correction's proposal, claimed before its first provider send: one
// row per correction (`live_correction_proposals`). The claim and the
// settlement each run under the correction's live worker lease, read through
// `readCorrectionForRun` (the check `correction-receipts.ts` makes), so the
// correction row is locked first: a second claim of the same correction waits
// for the first to commit, then finds its row and claims nothing.

import type { TenantQuery } from '../tenancy/database.ts';
import { readCorrectionForRun, type UnderLease } from './correction-receipts.ts';
import type { LiveCorrection } from './live-corrections.ts';

export type ProposalState = 'claimed' | 'proposed' | 'unknown';

export interface CorrectionProposal {
  readonly correctionId: string;
  readonly seam: string;
  readonly baseRevision: string;
  readonly preImageBlob: string;
  readonly head: string | null;
  readonly request: string | null;
  readonly state: ProposalState;
}

type Refused = { readonly ok: false; readonly code: string };

export type Claimed =
  | {
      readonly ok: true;
      readonly correction: LiveCorrection;
      readonly proposal: CorrectionProposal;
      /** True only for the claim that wrote the row: the one run that may send. */
      readonly fresh: boolean;
    }
  | Refused;

const COLUMNS = `correction_id as "correctionId", seam_branch as seam,
  base_revision as "baseRevision", pre_image_blob as "preImageBlob",
  head_commit as head, request_number as request, state`;

/** The correction's proposal row, or nothing. */
export async function readProposal(
  tx: TenantQuery,
  correctionId: string,
): Promise<CorrectionProposal | undefined> {
  const rows = await tx.query<CorrectionProposal>(
    `select ${COLUMNS} from public.live_correction_proposals
      where business_id = $1 and correction_id = $2`,
    [tx.businessId, correctionId],
  );
  return rows[0];
}

/**
 * The claim, under the lease: the row written when the correction has none and
 * stands approved, at its seam and base revision with the pre-image blob given;
 * else the row it already has. A correction with neither is `APPROVAL_MISSING`.
 */
export async function claimProposal(
  tx: TenantQuery,
  at: UnderLease,
  preImageBlob: string,
): Promise<Claimed> {
  const held = await readCorrectionForRun(tx, at);
  if (!held.ok) return held;
  const { correction } = held;
  const before = await readProposal(tx, at.correctionId);
  if (before !== undefined) return { ok: true, correction, proposal: before, fresh: false };
  if (correction.state !== 'approved') return { ok: false, code: 'APPROVAL_MISSING' };
  const [written] = await tx.query<CorrectionProposal>(
    `insert into public.live_correction_proposals
       (business_id, correction_id, seam_branch, base_revision, pre_image_blob, lease_id, fence)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning ${COLUMNS}`,
    [
      tx.businessId,
      at.correctionId,
      correction.seam,
      correction.baseRevision,
      preImageBlob,
      at.leaseId,
      at.fence,
    ],
  );
  if (written === undefined) throw new Error('claimProposal: the insert returned no row');
  return { ok: true, correction, proposal: written, fresh: true };
}

export type Settlement =
  | { readonly state: 'proposed'; readonly head: string; readonly request: string }
  | { readonly state: 'unknown' };

/**
 * A claimed row settled under the lease, once: the row as it then stands. A
 * row another run settled first keeps its answer, and that answer is returned.
 */
export async function settleProposal(
  tx: TenantQuery,
  at: UnderLease,
  settlement: Settlement,
): Promise<{ readonly ok: true; readonly proposal: CorrectionProposal } | Refused> {
  const held = await readCorrectionForRun(tx, at);
  if (!held.ok) return held;
  const proposed = settlement.state === 'proposed';
  await tx.query(
    `update public.live_correction_proposals
        set state = $3, head_commit = $4, request_number = $5, settled_at = clock_timestamp()
      where business_id = $1 and correction_id = $2 and state = 'claimed'`,
    [
      tx.businessId,
      at.correctionId,
      settlement.state,
      proposed ? settlement.head : null,
      proposed ? settlement.request : null,
    ],
  );
  const proposal = await readProposal(tx, at.correctionId);
  return proposal === undefined ? { ok: false, code: 'NOT_FOUND' } : { ok: true, proposal };
}
