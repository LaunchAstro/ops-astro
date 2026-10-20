// SPDX-License-Identifier: AGPL-3.0-only
//
// The client's Reviews page (PROTO-GAPS row 7, the director's ruling of register 268): the
// reviews the caller's grant covers at their holder, each with its current revision, that
// revision's approval and the review's change requests by state. Filtered by the grant inside
// the query (`covering.ts`), so a party grant reads no other client's review. Never a
// revision's digest, a decider, a capture or a change request's text: those are the team's
// (`review-reads.ts`). The pins and comments come from the task's client projection, in the read.

import type { TenantQuery } from '../tenancy/database.ts';
import { COVERED, EFFECTIVE_AT, coveringParameters, type Covering } from '../site/covering.ts';
import type { ChangeRequestState } from './change-requests.ts';

export interface ClientReviewRow {
  readonly reviewId: string;
  readonly taskId: string;
  readonly kind: 'page' | 'media';
  readonly pageUrl: string | null;
  readonly path: string | null;
  /** The current revision's number; null for a review with none. */
  readonly revision: number | null;
  /** The current revision's approval, or null while it is undecided. */
  readonly approved: { readonly decidedAt: string } | null;
  /** Every revision's id, to keep the task's pins on this review apart from another's. */
  readonly revisionIds: readonly string[];
  readonly changeRequests: readonly {
    readonly changeRequestId: string;
    readonly commentId: string;
    readonly state: ChangeRequestState;
  }[];
}

/** The most reviews the page reads at once. */
export const CLIENT_REVIEW_LIMIT = 100;

/** The reviews the caller's grant covers, newest change first, filtered in the query. */
export async function readClientReviews(
  tx: TenantQuery,
  covering: Covering,
): Promise<readonly ClientReviewRow[]> {
  const rows = await tx.query<{
    readonly id: string;
    readonly task_id: string;
    readonly kind: 'page' | 'media';
    readonly page_url: string | null;
    readonly path: string | null;
    readonly revision: number | null;
    readonly decided_at: string | null;
    readonly revision_ids: readonly string[];
  }>(
    `${EFFECTIVE_AT}
     select c.id, c.task_id, c.kind, c.page_url, c.path, v.number as revision,
            d.created_at::text as decided_at,
            array(select r.id::text from public.review_revisions r
                   where r.business_id = c.business_id and r.review_id = c.id) as revision_ids
       from public.reviews c
       left join lateral (
         select r.id, r.number from public.review_revisions r
          where r.business_id = c.business_id and r.review_id = c.id
          order by r.number desc limit 1) v on true
       left join public.review_decisions d
         on d.business_id = c.business_id and d.revision_id = v.id and d.response = 'approve'
      where c.business_id = $1 and ${COVERED}
      order by c.updated_at desc, c.id
      limit ${CLIENT_REVIEW_LIMIT}`,
    [tx.businessId, ...coveringParameters(covering)],
  );
  const requests = await changeRequestsOf(
    tx,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    reviewId: row.id,
    taskId: row.task_id,
    kind: row.kind,
    pageUrl: row.page_url,
    path: row.path,
    revision: row.revision,
    approved: row.decided_at === null ? null : { decidedAt: row.decided_at },
    revisionIds: row.revision_ids,
    changeRequests: requests.get(row.id) ?? [],
  }));
}

/** The listed reviews' change requests, oldest first, by review: id, pin and state alone. */
async function changeRequestsOf(
  tx: TenantQuery,
  reviewIds: readonly string[],
): Promise<ReadonlyMap<string, ClientReviewRow['changeRequests']>> {
  const rows = await tx.query<{
    readonly id: string;
    readonly review_id: string;
    readonly comment_id: string;
    readonly state: ChangeRequestState;
  }>(
    `select id, review_id, comment_id, state from public.review_change_requests
      where business_id = $1 and review_id = any($2::uuid[]) order by created_at, id`,
    [tx.businessId, reviewIds],
  );
  const byReview = new Map<string, ClientReviewRow['changeRequests'][number][]>();
  for (const row of rows) {
    const held = byReview.get(row.review_id) ?? [];
    held.push({ changeRequestId: row.id, commentId: row.comment_id, state: row.state });
    byReview.set(row.review_id, held);
  }
  return byReview;
}

/**
 * Which of `reviewIds` the caller's grant still covers, judged at this statement's own instant.
 * Asked after the read's last statement, so a grant revoked or expired while the comments were
 * read covers nothing written since (S2237-2).
 */
export async function stillCovered(
  tx: TenantQuery,
  covering: Covering,
  reviewIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const rows = await tx.query<{ readonly id: string }>(
    `${EFFECTIVE_AT}
     select c.id from public.reviews c
      where c.business_id = $1 and c.id = any($6::uuid[]) and ${COVERED}`,
    [tx.businessId, ...coveringParameters(covering), reviewIds],
  );
  return new Set(rows.map((row) => row.id));
}
