-- SPDX-License-Identifier: AGPL-3.0-only
--
-- A run event's write instant, read after its writer's locks.
--
-- `created_at` is the writing transaction's start. A hand-back that waited on
-- its locks while a model call on its lease settled keeps a time before that
-- settlement, so the trace export's call counts, bounded by it, missed a call
-- the hand-back had already seen settled.
--
-- * `run_events.written_at`: the server's clock as the row is inserted, after
--   every lock its writer holds. The trigger that stamps `tx` stamps it too,
--   whatever the insert supplies.
-- * The table is append only, so rows already written keep a null, and a
--   reader takes their `created_at`. The check holds every new row to a value.

alter table public.run_events add column written_at timestamptz;

alter table public.run_events
  add constraint run_events_written_at_stamped check (written_at is not null) not valid;

create or replace function public.run_events_stamp_tx()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  new.tx := pg_current_xact_id();
  new.written_at := clock_timestamp();
  return new;
end;
$$;
