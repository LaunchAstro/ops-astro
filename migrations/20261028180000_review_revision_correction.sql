-- SPDX-License-Identifier: AGPL-3.0-only
--
-- C35-X (#2120): a revision opened on a page after its live correction
-- published names that correction, so the review workspace can show the
-- publish's Receipt. This is review metadata: `review.open` names only a
-- correction on the review's own task and page whose receipts the opener
-- reads, and the Receipt is read through `live_correction.receipts`
-- unchanged. A revision is never changed, so neither is its correction.

alter table public.review_revisions
  add column correction_id uuid,
  add constraint review_revisions_correction_fkey foreign key (business_id, correction_id)
    references public.live_corrections (business_id, id);

create index review_revisions_correction_idx
  on public.review_revisions (business_id, correction_id) where correction_id is not null;
