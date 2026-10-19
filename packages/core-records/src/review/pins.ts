// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's pins (#2012). A pin is a comment on the review's task (`task_comment`) whose `anchor`
// field is a W3C Web Annotation target: the revision as source, one width's capture, and the
// selectors that find the spot on it (parsed in `core-commands`' `review-anchor.ts`). There is
// no pin table; the comment's audience decides who sees it, as for any comment.

import type { TenantQuery } from '../tenancy/database.ts';
import type { Covering } from '../site/covering.ts';
import { lockCoveredReview, type CaptureWidth, type Review } from './reviews.ts';

export type Selector =
  | { readonly type: 'FragmentSelector'; readonly conformsTo: string; readonly value: string }
  | {
      readonly type: 'TextQuoteSelector';
      readonly exact: string;
      readonly prefix?: string;
      readonly suffix?: string;
    };

/** A pin's target: the revision, the capture's width, and how to find the spot on it. */
export interface Anchor {
  readonly source: string;
  readonly width: CaptureWidth;
  readonly selector: readonly Selector[];
}

export interface PinView {
  readonly commentId: string;
  readonly audience: 'internal' | 'client';
  readonly body: string;
  readonly anchor: Anchor;
}

/** The review's task a revision belongs to, read in this business; nothing for a foreign id. */
export async function taskOfRevision(
  tx: TenantQuery,
  revisionId: string,
): Promise<{ readonly reviewId: string; readonly taskId: string } | undefined> {
  const [row] = await tx.query<{ readonly review_id: string; readonly task_id: string }>(
    `select c.id as review_id, c.task_id from public.review_revisions v
       join public.reviews c on c.business_id = v.business_id and c.id = v.review_id
      where v.business_id = $1 and v.id = $2`,
    [tx.businessId, revisionId],
  );
  return row === undefined ? undefined : { reviewId: row.review_id, taskId: row.task_id };
}

/**
 * The review a pin on `anchor` lands on, locked and covered for the caller, with the widths
 * its revision was captured at; or undefined when the caller's grant does not cover it. The
 * caller has locked the review's task first, as `review.open` does.
 */
export async function lockPinnedReview(
  tx: TenantQuery,
  reviewId: string,
  revisionId: string,
  covering: Covering,
): Promise<{ readonly review: Review; readonly widths: readonly number[] } | undefined> {
  const review = await lockCoveredReview(tx, reviewId, covering);
  if (review === undefined) return undefined;
  const rows = await tx.query<{ readonly width: number }>(
    `select width from public.review_captures where business_id = $1 and revision_id = $2`,
    [tx.businessId, revisionId],
  );
  return { review, widths: rows.map((row) => row.width) };
}

/** Every live pin on the review's revisions, oldest first; the caller has judged the review. */
export async function readPins(
  tx: TenantQuery,
  review: { readonly reviewId: string; readonly taskId: string },
): Promise<readonly PinView[]> {
  const rows = await tx.query<{
    readonly id: string;
    readonly audience: PinView['audience'];
    readonly body: string;
    readonly anchor: Anchor;
  }>(
    `select r.id, r.data->>'audience' as audience, r.data->>'body' as body,
            r.data->'anchor' as anchor
       from public.records r
       join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
      where r.business_id = $1 and t.key = 'task_comment' and r.data ->> 'task' = $2
        and r.deleted_at is null and r.data ? 'anchor'
        and r.data->'anchor'->>'source' in (
          select v.id::text from public.review_revisions v
           where v.business_id = $1 and v.review_id = $3)
      order by r.created_at, r.id`,
    // A comment names its task as lowercase text, so the id is compared as one.
    [tx.businessId, review.taskId.toLowerCase(), review.reviewId],
  );
  return rows.map((row) => ({
    commentId: row.id,
    audience: row.audience,
    body: row.body,
    anchor: row.anchor,
  }));
}
