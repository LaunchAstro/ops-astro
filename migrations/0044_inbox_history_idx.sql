-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0044 the inbox's closed history, newest first (INB-1, the read's cost).
--
-- The inbox read carries every open item and a page of the newest closed
-- ones. The first index hands it one recipient's closed items in the page's
-- own order, so a read stops at what it needs instead of reading the whole
-- history to sort it: the scan is bounded, not the person's history. It
-- serves a reader who reads the whole business, and the withheld history
-- read beside the page.
--
-- Otherwise the page is found from the reader's grants: each task they read
-- gives its newest few items for the reader, so an item about a task they
-- cannot read never takes a place in the page. The second index hands the
-- read one reader's closed items on one task in the page's order. The third
-- finds the tasks a client grant reaches, trashed ones included (a trashed
-- task's items read back as gone, not withheld); 0006's index on the same
-- slot leaves trashed rows out.

create index inbox_items_recipient_history_idx
  on public.inbox_items (business_id, recipient_person_id, closed_at desc, id desc)
  where work_state <> 'open';

create index inbox_items_subject_history_idx
  on public.inbox_items
    (business_id, recipient_person_id, subject_record_id, closed_at desc, id desc)
  where work_state <> 'open';

create index records_client_idx
  on public.records (business_id, uuid_7)
  where uuid_7 is not null;
