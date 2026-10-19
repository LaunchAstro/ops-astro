// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's worker writes on the captures (#2011): the claim and the land. Their authority is the
// lease, which the caller has locked and re-checked (`lockOwnedLease`) before these run, and
// they reach only captures of a review on the lease's own task: a revision of another task's
// review, or of another business's, is not found.

import type { TenantQuery } from '../tenancy/database.ts';
import type { CaptureWidth } from './reviews.ts';

/** Where the worker stands: the lease's task, the lease and its fence. */
export interface CaptureLease {
  readonly taskId: string;
  readonly leaseId: string;
  readonly fence: number;
}

export type CaptureRefusal = { readonly code: 'NOT_FOUND' | 'CAPTURE_NOT_CLAIMABLE' };

/**
 * Claim a revision's captures not yet landed for the lease, all at once. The rows are locked
 * first; then each must be requested, or claimed under a lease no longer live at the instant read
 * after that lock wait. A second worker waits on the rows and then finds them claimed under a live
 * lease, so one claim wins. A width landed before its lease ended stays landed, and a later lease
 * claims the rest. A revision with nothing left to land is not claimable; one of a review on
 * another task is not found.
 */
export async function claimCaptures(
  tx: TenantQuery,
  revisionId: string,
  lease: CaptureLease,
): Promise<{ readonly widths: readonly CaptureWidth[] } | CaptureRefusal> {
  const locked = await tx.query<{ readonly id: string }>(
    `select k.id from public.review_captures k
       join public.review_revisions v on v.business_id = k.business_id and v.id = k.revision_id
       join public.reviews c on c.business_id = v.business_id and c.id = v.review_id
      where k.business_id = $1 and k.revision_id = $2 and c.task_id = $3
      order by k.width
        for update of k`,
    [tx.businessId, revisionId, lease.taskId],
  );
  if (locked.length === 0) return { code: 'NOT_FOUND' };
  const rows = await tx.query<{
    readonly id: string;
    readonly width: CaptureWidth;
    readonly claimable: boolean;
  }>(
    `select k.id, k.width,
            k.state = 'requested' or (k.state = 'claimed' and not exists (
              select 1 from public.leases l
               where l.business_id = k.business_id and l.id = k.lease_id
                 and l.state = 'live' and l.expires_at > clock_timestamp())) as claimable
       from public.review_captures k
      where k.business_id = $1 and k.id = any($2::uuid[]) and k.state <> 'landed'
      order by k.width`,
    [tx.businessId, locked.map((row) => row.id)],
  );
  if (rows.length === 0 || !rows.every((row) => row.claimable)) {
    return { code: 'CAPTURE_NOT_CLAIMABLE' };
  }
  await tx.query(
    `update public.review_captures
        set state = 'claimed', lease_id = $3, fence = $4, updated_at = now()
      where business_id = $1 and id = any($2::uuid[])`,
    [tx.businessId, rows.map((row) => row.id), lease.leaseId, lease.fence],
  );
  return { widths: rows.map((row) => row.width) };
}

export type LandRefusal = { readonly code: 'NOT_FOUND' | 'CAPTURE_NOT_CLAIMED' };

/**
 * The claimed capture at one width, locked, if this lease at this fence claimed it: the row a
 * land writes. Another lease's claim, a landed or unclaimed row is `CAPTURE_NOT_CLAIMED`; a
 * revision of a review on another task, or in another business, is not found.
 */
export async function lockClaimedCapture(
  tx: TenantQuery,
  at: { readonly revisionId: string; readonly width: CaptureWidth },
  lease: CaptureLease,
): Promise<{ readonly captureId: string } | LandRefusal> {
  const [row] = await tx.query<{
    readonly id: string;
    readonly state: string;
    readonly lease_id: string | null;
    readonly fence: string | null;
  }>(
    `select k.id, k.state, k.lease_id, k.fence::text as fence
       from public.review_captures k
       join public.review_revisions v on v.business_id = k.business_id and v.id = k.revision_id
       join public.reviews c on c.business_id = v.business_id and c.id = v.review_id
      where k.business_id = $1 and k.revision_id = $2 and k.width = $3 and c.task_id = $4
        for update of k`,
    [tx.businessId, at.revisionId, at.width, lease.taskId],
  );
  if (row === undefined) return { code: 'NOT_FOUND' };
  const ours =
    row.state === 'claimed' && row.lease_id === lease.leaseId && row.fence === String(lease.fence);
  return ours ? { captureId: row.id } : { code: 'CAPTURE_NOT_CLAIMED' };
}

/** Land a capture this lease holds locked: its observation and the stored picture's id and digest. */
export async function writeLandedCapture(
  tx: TenantQuery,
  captureId: string,
  landed: {
    readonly observation: Readonly<Record<string, unknown>>;
    readonly pictureId: string;
    readonly pictureDigest: string;
  },
): Promise<void> {
  await tx.query(
    `update public.review_captures
        set state = 'landed', observation = $3::text::jsonb, picture_id = $4,
            picture_digest = $5, landed_at = now(), updated_at = now()
      where business_id = $1 and id = $2`,
    [
      tx.businessId,
      captureId,
      JSON.stringify(landed.observation),
      landed.pictureId,
      landed.pictureDigest,
    ],
  );
}
