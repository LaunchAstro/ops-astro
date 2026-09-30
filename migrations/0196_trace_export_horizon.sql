-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0196 the trace export reads below the transaction horizon (AW-13).
--
-- 0195's cursor ordered events by (created_at, id), and created_at is the
-- writing transaction's start. A transaction that started first and
-- committed last left its event behind a cursor that had already moved past
-- it: never exported and never a gap.
--
-- * `run_events.tx`: the writing transaction's id (`xid8`, never wraps),
--   stamped by a trigger whatever the insert supplies. Existing rows take
--   this migration's own id.
-- * The exporter reads only events whose transaction is below its
--   snapshot's horizon (`pg_snapshot_xmin`): every transaction below it has
--   finished, and any later write gets a higher id, so nothing can land
--   behind the cursor. It orders by (tx, id).
-- * `trace_export_cursors.after_tx` and `trace_export_gaps.from_tx` replace
--   the timestamps. A cursor from before this migration restarts from the
--   start: duplicates are harmless because the ids are derived.

alter table public.run_events
  add column tx xid8 not null default pg_current_xact_id();

create index run_events_business_tx_idx on public.run_events (business_id, tx, id);

-- The stamp is the server's, never the caller's: the application group's
-- insert grant covers every column, and a supplied `tx` could hide an event
-- below the cursor or hold it above the horizon for good.
create or replace function public.run_events_stamp_tx()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  new.tx := pg_current_xact_id();
  return new;
end;
$$;

revoke all on function public.run_events_stamp_tx() from public;

create trigger run_events_stamp_tx
  before insert on public.run_events
  for each row execute function public.run_events_stamp_tx();

alter table public.trace_export_cursors drop constraint trace_export_cursors_whole;
alter table public.trace_export_cursors drop column after_at;
update public.trace_export_cursors set after_id = null;
alter table public.trace_export_cursors add column after_tx xid8;
alter table public.trace_export_cursors add constraint trace_export_cursors_whole
  check ((after_tx is null) = (after_id is null));

alter table public.trace_export_gaps drop column from_at;
alter table public.trace_export_gaps add column from_tx xid8;
