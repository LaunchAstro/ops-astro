-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0211 a missing audit copy on the outage report (AW-04). A pinned read whose
-- audit copy the store could not keep goes through, and the team is told on
-- the report T3e2 already gives it on `task.queue`: one row per business and
-- digest, cause `audit_copy_missing`, which a second miss of the digest joins.
-- The digest names the file; the row lists no runs, since none was dropped.
--
-- A drop's report keeps its one open row per business and cause; a copy's row
-- is keyed by its digest instead, so two digests missing at once are two rows.
-- No function is created and no grant changes.

alter table public.outage_reports add column content_digest text;

alter table public.outage_reports drop constraint outage_reports_cause_known;
alter table public.outage_reports add constraint outage_reports_cause_known
  check (cause in ('provider_unavailable', 'connection_lost', 'worker_lost', 'audit_copy_missing'));

alter table public.outage_reports add constraint outage_reports_digest_names_the_copy
  check (
    (cause = 'audit_copy_missing') = (content_digest is not null)
    and (content_digest is null or content_digest ~ '^[0-9a-f]{64}$')
  );

drop index public.outage_reports_one_open_idx;
create unique index outage_reports_one_open_idx
  on public.outage_reports (business_id, cause) where closed_at is null and content_digest is null;

create unique index outage_reports_one_per_copy_idx
  on public.outage_reports (business_id, content_digest) where content_digest is not null;
