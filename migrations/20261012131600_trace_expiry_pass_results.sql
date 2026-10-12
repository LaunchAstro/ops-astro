-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Trace retention's pass results (#994, #1433 P04).
--
-- A read that finds a run's trace gone confirms it only when the pass before
-- also found it gone: one 404 may be a span the store has not yet ingested.
-- So every pass that reads a run records what it found, on the append-only
-- batch row: the runs read absent, read present, and those it had no answer
-- for. The row names its pass (`pass_id`, one per deployment pass, kept by a
-- retried business turn) and the business's turn number (`pass_seq`, taken
-- from the cursor row once per turn), so two absences count only from
-- different passes with no turn between them.
--
-- A run still unconfirmed once its ask is older than the window is settled
-- once, `unconfirmed_expired`, naming it among the unread runs, and is never
-- read or asked again.
--
-- No function is added; both tables already have row security enabled,
-- forced and keyed on the business, and the grants stand.

alter table public.trace_expiry_batches
  add column pass_id uuid,
  add column pass_seq bigint,
  add column absent_run_ids uuid[] not null default '{}',
  add column present_run_ids uuid[] not null default '{}',
  add column unread_run_ids uuid[] not null default '{}',
  drop constraint trace_expiry_batches_code_known,
  add constraint trace_expiry_batches_code_known check (code is null or code in (
    'target_unreachable', 'target_redirect', 'target_timeout', 'target_oversized_reply',
    'target_oversized_body', 'target_malformed_reply', 'target_refused', 'target_forbidden',
    'expiry_unconfirmed', 'unconfirmed_expired'));

create index trace_expiry_batches_absent_idx
  on public.trace_expiry_batches using gin (absent_run_ids);

create index trace_expiry_batches_present_idx
  on public.trace_expiry_batches using gin (present_run_ids);

create index trace_expiry_batches_unread_idx
  on public.trace_expiry_batches using gin (unread_run_ids);

alter table public.trace_export_cursors
  add column pass_seq bigint not null default 0;
