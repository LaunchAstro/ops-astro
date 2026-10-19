// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X (#2120): which live correction a page revision may name, and what a live-view pin
// may land on. A correction's task, page and file never change, so they are read without a
// lock; whether its receipts reach the opener is `live_correction.receipts`' own read.

import type { TenantQuery } from '../tenancy/database.ts';
import type { CaptureWidth } from './reviews.ts';

/** Whether `correctionId` is a correction on `page`'s own task, page and file. */
export async function correctionOnPage(
  tx: TenantQuery,
  correctionId: string,
  page: { readonly taskId: string; readonly pageUrl: string; readonly path: string },
): Promise<boolean> {
  const rows = await tx.query<{ readonly id: string }>(
    `select c.id from public.live_corrections c
      where c.business_id = $1 and c.id = $2 and c.task_id = $3 and c.page_url = $4
        and c.target_path = $5`,
    [tx.businessId, correctionId, page.taskId, page.pageUrl, page.path],
  );
  return rows.length > 0;
}

/**
 * Whether the live view beside the capture still corresponds to it: the revision is the
 * newest of its review and its capture at `width` has landed. Read after the review's row
 * lock, which a new revision is numbered under.
 */
export async function capturedNewest(
  tx: TenantQuery,
  revisionId: string,
  width: CaptureWidth,
): Promise<boolean> {
  const rows = await tx.query<{ readonly id: string }>(
    `select k.id from public.review_captures k
       join public.review_revisions v on v.business_id = k.business_id and v.id = k.revision_id
       join public.reviews c on c.business_id = v.business_id and c.id = v.review_id
      where k.business_id = $1 and k.revision_id = $2 and k.width = $3
        and k.state = 'landed' and v.number = c.revision_count`,
    [tx.businessId, revisionId, width],
  );
  return rows.length > 0;
}
