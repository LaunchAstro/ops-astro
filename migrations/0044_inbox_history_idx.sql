-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0044 the inbox's closed history, newest first (INB-1, the read's cost).
--
-- The inbox read carries every open item and a page of the newest closed
-- ones. This index hands it one recipient's closed items in the page's own
-- order, so the read stops at the page instead of reading the whole history
-- to sort it: the scan is bounded, not the person's history.

create index inbox_items_recipient_history_idx
  on public.inbox_items (business_id, recipient_person_id, closed_at desc, id desc)
  where work_state <> 'open';
