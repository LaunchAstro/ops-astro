-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0035 the live task channel (T2f).
--
-- A write to a task's run or record emits a content-free invalidation from
-- inside its own transaction. `pg_notify` is delivered at commit and never on
-- rollback, a rolled-back savepoint's included, and a row that row security
-- refuses never reaches an AFTER trigger. The payload is frozen as
-- `business:kind:topic`: kind `task`, topic the task's identifier. The API
-- fans it out by the business it names and nothing else; a reader learns only
-- that something changed and re-reads through the ordinary checked read.
--
-- Records change in bulk (trash, purge), so their trigger is per statement
-- and names each task once. A comment is a record whose `task` field names its
-- task, so it invalidates that task.

create function public.live_task_topic()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  perform pg_notify('ops_astro_live', new.business_id::text || ':task:' || new.task_id::text);
  return null;
end;
$$;

revoke all on function public.live_task_topic() from public;

create trigger run_events_live
  after insert on public.run_events
  for each row execute function public.live_task_topic();

create trigger planned_runs_live
  after insert or update on public.planned_runs
  for each row execute function public.live_task_topic();

create function public.live_record_topics()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  perform pg_notify('ops_astro_live', topic)
     from (select distinct changed.business_id::text || ':task:'
                  || coalesce(changed.data ->> 'task', changed.id::text) as topic
             from changed) as topics;
  return null;
end;
$$;

revoke all on function public.live_record_topics() from public;

create trigger records_live_insert
  after insert on public.records
  referencing new table as changed
  for each statement execute function public.live_record_topics();

create trigger records_live_update
  after update on public.records
  referencing new table as changed
  for each statement execute function public.live_record_topics();

create trigger records_live_delete
  after delete on public.records
  referencing old table as changed
  for each statement execute function public.live_record_topics();
