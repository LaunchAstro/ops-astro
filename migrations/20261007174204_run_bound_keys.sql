-- SPDX-License-Identifier: AGPL-3.0-only
-- A run-side row's references must describe that run. Refuse inconsistent
-- stored rows before changing any key; no history is repaired or removed.

lock table public.bootstrap_reads, public.run_checks, public.model_calls,
           public.planned_steps, public.planned_runs, public.leases,
           public.attempts, public.reservations in share row exclusive mode;

do $$
declare
  bad_reference text;
begin
  select reference into bad_reference from (
    select 'bootstrap_reads.step_id' as reference
      from public.bootstrap_reads c
     where c.step_id is not null and not exists (
       select 1 from public.planned_steps p
        where p.business_id = c.business_id and p.run_id = c.run_id and p.id = c.step_id
     )
    union all
    select 'run_checks.lease_id' as reference
      from public.run_checks c
     where c.lease_id is not null and not exists (
       select 1 from public.leases p
        where p.business_id = c.business_id and p.run_id = c.run_id and p.id = c.lease_id
     )
    union all
    select 'run_checks.attempt_id' as reference
      from public.run_checks c
     where c.attempt_id is not null and not exists (
       select 1 from public.attempts p
        where p.business_id = c.business_id and p.run_id = c.run_id and p.id = c.attempt_id
     )
    union all
    select 'model_calls.step_id' as reference
      from public.model_calls c
     where c.step_id is not null and not exists (
       select 1 from public.planned_steps p
        where p.business_id = c.business_id and p.run_id = c.run_id and p.id = c.step_id
     )
    union all
    select 'model_calls.lease_id' as reference
      from public.model_calls c
     where c.lease_id is not null and not exists (
       select 1 from public.leases p
        where p.business_id = c.business_id and p.run_id = c.run_id and p.id = c.lease_id
     )
    union all
    select 'model_calls.reservation_id' as reference
      from public.model_calls c
     where c.reservation_id is not null and not exists (
       select 1 from public.reservations p
        where p.business_id = c.business_id and p.run_id = c.run_id and p.id = c.reservation_id
     )
    union all
    select 'run_checks.task_id' as reference
      from public.run_checks c
     where c.run_id is not null and not exists (
       select 1 from public.planned_runs p
        where p.business_id = c.business_id and p.id = c.run_id and p.task_id = c.task_id
     )
    union all
    select 'model_calls.version_id' as reference
      from public.model_calls c
     where c.run_id is not null and not exists (
       select 1 from public.planned_runs p
        where p.business_id = c.business_id and p.id = c.run_id and p.version_id = c.version_id
     )
  ) invalid limit 1;
  if bad_reference is not null then
    raise exception 'run-bound references: % contains orphaned or cross-run rows', bad_reference
      using errcode = '23503';
  end if;
end;
$$;

alter table public.planned_steps
  add constraint planned_steps_run_id_key unique (business_id, run_id, id);

alter table public.leases
  add constraint leases_run_id_key unique (business_id, run_id, id);

alter table public.attempts
  add constraint attempts_run_id_key unique (business_id, run_id, id);

alter table public.reservations
  add constraint reservations_run_id_key unique (business_id, run_id, id);

alter table public.bootstrap_reads
  drop constraint bootstrap_reads_step_fkey,
  add constraint bootstrap_reads_step_fkey foreign key (business_id, run_id, step_id)
    references public.planned_steps (business_id, run_id, id);

alter table public.run_checks
  drop constraint run_checks_lease_fkey,
  add constraint run_checks_lease_fkey foreign key (business_id, run_id, lease_id)
    references public.leases (business_id, run_id, id);

alter table public.run_checks
  drop constraint run_checks_attempt_fkey,
  add constraint run_checks_attempt_fkey foreign key (business_id, run_id, attempt_id)
    references public.attempts (business_id, run_id, id);

alter table public.model_calls
  drop constraint model_calls_step_fkey,
  add constraint model_calls_step_fkey foreign key (business_id, run_id, step_id)
    references public.planned_steps (business_id, run_id, id);

alter table public.model_calls
  drop constraint model_calls_lease_fkey,
  add constraint model_calls_lease_fkey foreign key (business_id, run_id, lease_id)
    references public.leases (business_id, run_id, id);

alter table public.model_calls
  drop constraint model_calls_reservation_fkey,
  add constraint model_calls_reservation_fkey foreign key (business_id, run_id, reservation_id)
    references public.reservations (business_id, run_id, id);

alter table public.run_checks
  add constraint run_checks_task_in_run foreign key (business_id, run_id, task_id)
    references public.planned_runs (business_id, id, task_id);

alter table public.model_calls
  drop constraint model_calls_run_fkey,
  add constraint model_calls_run_fkey foreign key (business_id, run_id, version_id)
    references public.planned_runs (business_id, id, version_id);
