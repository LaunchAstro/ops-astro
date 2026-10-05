-- SPDX-License-Identifier: AGPL-3.0-only
--
-- A planned run's `ended_at` is the database's clock at the moment the run
-- left work: handed back, or cancelled (catalogue #485, SOLOW-B B3). A
-- conversation holds its body while the runs it started are open and for its
-- window after the latest end (AW-03), so it needs each run's end. The end
-- was derived: a hand-back from its run event, a cancel from its lineage's
-- `terminal_at`. A budget stop's end (`endAtBudgetStop`) and a last ask spent
-- cancel the run and leave the lineage live, so no end was ever found and the
-- body was held for good.
--
-- The server stamps the end on every change of state, whatever the statement
-- supplies: `clock_timestamp()` into handed_back or cancelled, cleared on a
-- claim after a hand-back, and unchanged by any write that leaves the state
-- alone. The clock is read as the row changes, after any lock the change
-- waited on, not at the transaction's start: an end held up by another
-- writer is never stamped before the run could leave work. Rows
-- already written: a hand-back takes its run event's time; a cancel, whose
-- time was never stored, takes this migration's instant (later than the true
-- end, never earlier, so no body is purged early).

alter table public.planned_runs add column ended_at timestamptz;

update public.planned_runs run
   set ended_at = case run.state
         when 'handed_back' then coalesce(
           (select max(e.created_at) from public.run_events e
             where e.business_id = run.business_id and e.run_id = run.id
               and e.kind = 'handed_back'),
           now())
         else now()
       end
 where run.state in ('handed_back', 'cancelled');

create function public.planned_runs_stamp_end() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE' and new.state is not distinct from old.state then
    new.ended_at := old.ended_at;
  elsif new.state in ('handed_back', 'cancelled') then
    new.ended_at := clock_timestamp();
  else
    new.ended_at := null;
  end if;
  return new;
end;
$$;

revoke all on function public.planned_runs_stamp_end() from public;

create trigger planned_runs_stamp_end
  before insert or update on public.planned_runs
  for each row execute function public.planned_runs_stamp_end();
