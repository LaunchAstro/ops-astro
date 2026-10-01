-- SPDX-License-Identifier: AGPL-3.0-only
--
-- MP-6-2 (ORCH49): the plan record a run's step was proposed under, stored.
--
-- `task.propose` checks a step key against the task's bound plan under the
-- task lock (0210); the operational log then placed the run by time, as the
-- newest record bound at or before the run's `created_at`. Both clocks are
-- their transaction's start, so an accept that began before a proposal and
-- took the task lock after it read as bound first, and moved the run's rows.
-- The record the proposal saw is now written with the step.
--
-- `plan_record_written` says the proposal wrote it: true with a record, or
-- true with none when no plan was bound. A row from before this migration
-- holds false and keeps the old placement by time; nothing here can tell
-- which record it saw, so no row is backfilled.
--
-- The record is one of this business's (the foreign key) on the step's own
-- task (the trigger), and both columns are fixed once written: the
-- application group keeps its update on the table for `dispatched_at`.

alter table public.planned_steps
  add column plan_record_id uuid,
  add column plan_record_written boolean not null default false,
  add constraint planned_steps_plan_record_fkey foreign key (business_id, plan_record_id)
    references public.plan_records (business_id, id),
  add constraint planned_steps_plan_record_written
    check (plan_record_written or plan_record_id is null);

create index planned_steps_plan_record_idx
  on public.planned_steps (business_id, plan_record_id)
  where plan_record_id is not null;

-- Invoker's rights: row security keeps both runs to this business.
create function public.planned_steps_plan_record_on_task() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'UPDATE' and (new.plan_record_id is distinct from old.plan_record_id
     or new.plan_record_written is distinct from old.plan_record_written) then
    raise exception 'planned_steps: the plan record is written once, at proposal'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' and new.plan_record_id is not null and not exists (
    select 1
      from public.plan_records pr
      join public.planned_runs plan_run
        on plan_run.business_id = pr.business_id and plan_run.id = pr.run_id
      join public.planned_runs step_run
        on step_run.business_id = new.business_id and step_run.id = new.run_id
     where pr.business_id = new.business_id and pr.id = new.plan_record_id
       and plan_run.task_id = step_run.task_id) then
    raise exception 'planned_steps: the plan record is one of the step''s own task'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.planned_steps_plan_record_on_task() from public;

create trigger planned_steps_plan_record_on_task
  before insert or update on public.planned_steps
  for each row execute function public.planned_steps_plan_record_on_task();
