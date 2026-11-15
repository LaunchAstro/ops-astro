// SPDX-License-Identifier: AGPL-3.0-only
//
// The Reviews page's read (#2157): the business's reviews the caller's `review:read` covers,
// filtered inside the query by the grant at each review's own holder, as `review.read` is.

import type { TenantQuery } from '../tenancy/database.ts';
import { COVERED, EFFECTIVE_AT, coveringParameters, type Covering } from '../site/covering.ts';

/** One row of the Reviews page: a review the caller's grant covers, without its revisions. */
export interface ReviewSummary {
  readonly reviewId: string;
  readonly taskId: string;
  /** The task's client; null for the business's own site. */
  readonly partyId: string | null;
  readonly kind: 'page' | 'media';
  readonly pageUrl: string | null;
  readonly path: string | null;
  readonly revisionCount: number;
  /** Live pins on any of its revisions not yet filed as a change request. */
  readonly openPins: number;
  /** Change requests still waiting for a decision (`proposed`). */
  readonly openChangeRequests: number;
  /** Its latest change: its own row, a pin on it or a change request from one. */
  readonly updatedAt: string;
}

/** The most rows the Reviews page reads at once. */
export const REVIEW_LIST_LIMIT = 200;

type ListedRow = {
  readonly id: string;
  readonly task_id: string;
  readonly party_id: string | null;
  readonly kind: 'page' | 'media';
  readonly page_url: string | null;
  readonly path: string | null;
  readonly revision_count: number;
  readonly open_pins: number;
  readonly open_requests: number;
  readonly updated_at: Date;
};

/**
 * Each covered review with its open pins and open change requests, newest change first. A pin
 * or a change request writes no review row, so a review's latest change is the newest of its
 * own row, its pins (any, deleted ones included) and its change requests.
 */
const LIST_SQL = `${EFFECTIVE_AT}
     select c.id, c.task_id, c.party_id, c.kind, c.page_url, c.path, c.revision_count,
            p.open_pins, q.open_requests,
            greatest(c.updated_at, p.pinned_at, q.requested_at) as updated_at
       from public.reviews c
      cross join lateral (
        select count(*) filter (
                 where r.deleted_at is null
                   and not exists (select 1 from public.review_change_requests f
                                    where f.business_id = c.business_id and f.comment_id = r.id)
               )::int as open_pins,
               max(r.updated_at) as pinned_at
          from public.records r
          join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
         where r.business_id = c.business_id and t.key = 'task_comment'
           and r.data ->> 'task' = c.task_id::text
           and r.data ? 'anchor'
           and r.data -> 'anchor' ->> 'source' in (
             select s.id::text from public.review_revisions s
              where s.business_id = c.business_id and s.review_id = c.id)) p
      cross join lateral (
        select count(*) filter (where k.state = 'proposed')::int as open_requests,
               max(k.updated_at) as requested_at
          from public.review_change_requests k
         where k.business_id = c.business_id and k.review_id = c.id) q
      where c.business_id = $1 and ${COVERED}
      order by updated_at desc, c.id
      limit ${REVIEW_LIST_LIMIT}`;

/** The business's reviews the caller's grant covers, newest change first, filtered in the query. */
export async function listCoveredReviews(
  tx: TenantQuery,
  covering: Covering,
): Promise<readonly ReviewSummary[]> {
  const rows = await tx.query<ListedRow>(LIST_SQL, [
    tx.businessId,
    ...coveringParameters(covering),
  ]);
  return rows.map((row) => ({
    reviewId: row.id,
    taskId: row.task_id,
    partyId: row.party_id,
    kind: row.kind,
    pageUrl: row.page_url,
    path: row.path,
    revisionCount: row.revision_count,
    openPins: row.open_pins,
    openChangeRequests: row.open_requests,
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}
