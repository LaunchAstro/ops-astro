-- SPDX-License-Identifier: AGPL-3.0-only
--
-- #2360: an agent's request to delete a task tells a person in their inbox.
--
-- A new reason, `delete_request`, owed (a person's Confirm or Keep), and a new
-- fact kind, `delete_request`, whose id is the request's own
-- (`task_delete_requests.id`). The item is raised with the request and closed
-- by its answer (`tasks-delete-request.ts`). Widening two checks only: every
-- existing row still passes, and restoring the old lists reverses it once no
-- row uses the new values.

alter table public.inbox_items drop constraint inbox_items_reason_known;
alter table public.inbox_items add constraint inbox_items_reason_known check (reason in (
  'decision', 'waiting_run', 'run_finished', 'assignment', 'mention', 'incident',
  'client_comment', 'delete_request'));

alter table public.inbox_items drop constraint inbox_items_fact_kind_known;
alter table public.inbox_items add constraint inbox_items_fact_kind_known
  check (fact_kind in ('gate', 'planned_run', 'record', 'operation', 'delete_request'));
