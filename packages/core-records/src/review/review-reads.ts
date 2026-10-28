// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's read (#2011): one review with its revisions and their captures. It
// filters by the caller's grant at the review's holder inside the query
// (`covering.ts`), so a party grant reads no other client's review.

import type { TenantQuery } from '../tenancy/database.ts';
import { COVERED, EFFECTIVE_AT, coveringParameters, type Covering } from '../site/covering.ts';
import type { CaptureWidth, Review } from './reviews.ts';

export interface CaptureView {
  readonly width: CaptureWidth;
  readonly state: 'requested' | 'claimed' | 'landed';
}

export interface RevisionView {
  readonly revisionId: string;
  readonly number: number;
  readonly digest: string;
  readonly captures: readonly CaptureView[];
}

export interface ReviewView extends Omit<Review, 'id' | 'revisionCount'> {
  readonly reviewId: string;
  readonly revisions: readonly RevisionView[];
}

/** One review the caller's grant covers, its revisions in number order, captures by width. */
export async function readCoveredReview(
  tx: TenantQuery,
  reviewId: string,
  covering: Covering,
): Promise<ReviewView | undefined> {
  const [review] = await tx.query<{
    readonly task_id: string;
    readonly party_id: string | null;
    readonly kind: 'page' | 'media';
    readonly page_url: string | null;
    readonly path: string | null;
  }>(
    `${EFFECTIVE_AT}
     select c.task_id, c.party_id, c.kind, c.page_url, c.path from public.reviews c
      where c.business_id = $1 and c.id = $6 and ${COVERED}`,
    [tx.businessId, ...coveringParameters(covering), reviewId],
  );
  if (review === undefined) return undefined;
  const revisions = await tx.query<{
    readonly id: string;
    readonly number: number;
    readonly digest: string;
  }>(
    `select id, number, digest from public.review_revisions
      where business_id = $1 and review_id = $2 order by number`,
    [tx.businessId, reviewId],
  );
  const captures = await capturesOf(tx, reviewId);
  return {
    reviewId,
    taskId: review.task_id,
    partyId: review.party_id,
    kind: review.kind,
    pageUrl: review.page_url,
    path: review.path,
    revisions: revisions.map((revision) => ({
      revisionId: revision.id,
      number: revision.number,
      digest: revision.digest,
      captures: captures.get(revision.id) ?? [],
    })),
  };
}

/** Every capture of the review's revisions, widest first, by the revision it is of. */
async function capturesOf(
  tx: TenantQuery,
  reviewId: string,
): Promise<ReadonlyMap<string, readonly CaptureView[]>> {
  const rows = await tx.query<{
    readonly revision_id: string;
    readonly width: CaptureWidth;
    readonly state: CaptureView['state'];
  }>(
    `select k.revision_id, k.width, k.state
       from public.review_captures k
       join public.review_revisions v on v.business_id = k.business_id and v.id = k.revision_id
      where k.business_id = $1 and v.review_id = $2
      order by k.width desc`,
    [tx.businessId, reviewId],
  );
  const byRevision = new Map<string, CaptureView[]>();
  for (const row of rows) {
    const captures = byRevision.get(row.revision_id) ?? [];
    captures.push({
      width: row.width,
      state: row.state,
    });
    byRevision.set(row.revision_id, captures);
  }
  return byRevision;
}
