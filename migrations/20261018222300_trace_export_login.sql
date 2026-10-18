-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The trace export's own role (#1708). Production's exporter runs on the M5
-- (`apps/trace-export/main.ts`) on a login that is a member of this group
-- alone and takes it in each transaction, so the process that sends traces off
-- the machine holds no more than the export reads and writes. It is under row
-- security like the application: every policy on these tables applies to every
-- role, and the export sets the business in each transaction.
--
-- What it may touch is what `exportOnce` and `expireOnce` touch
-- (`packages/core-runtime/src/trace-*.ts`), and no more:
-- - reads: the run events' cells a span is made of, never the task, attempt or
--   actor; the lease and model-call columns the call counts read; the trace
--   copies it registered;
-- - writes: its own cursor, gaps and retention record, and a run's trace copy.
-- No record, client, message, person or credential table is granted.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'ops_astro_trace') then
    create role ops_astro_trace nologin nosuperuser nocreatedb nocreaterole noreplication
      nobypassrls;
  end if;
  if exists (select 1 from pg_roles where rolname = 'ops_astro_trace' and (rolcanlogin
      or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) then
    alter role ops_astro_trace nologin nosuperuser nocreatedb nocreaterole noreplication
      nobypassrls;
  end if;
end $$;

revoke all on all tables in schema public from ops_astro_trace;
revoke all on all functions in schema public from ops_astro_trace;
grant usage on schema public to ops_astro_trace;
grant execute on function public.app_business_id() to ops_astro_trace;

grant select (business_id, id, run_id, position, kind, lease_id, detail, created_at, written_at,
  tx) on public.run_events to ops_astro_trace;
grant select (business_id, id, reservation_id) on public.leases to ops_astro_trace;
grant select (business_id, run_id, reservation_id, lease_id, accepted_at, state, ended_at)
  on public.model_calls to ops_astro_trace;
grant select (business_id, copy_class, copy_key),
  insert (business_id, id, copy_class, copy_key, invalidation_trigger, retention_class)
  on public.copy_registrations to ops_astro_trace;
grant select, insert, update on public.trace_export_cursors to ops_astro_trace;
grant select, insert on public.trace_export_gaps, public.trace_expiry_batches,
  public.trace_expiry_asks to ops_astro_trace;

comment on role ops_astro_trace is
  'The trace export''s role: reads the run-event cells and call counts a span is made of, '
  'writes its own cursor, gaps and retention record under row security. No one logs in as it; '
  'its login is a member of it alone.';
