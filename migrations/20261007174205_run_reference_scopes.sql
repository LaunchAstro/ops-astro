-- SPDX-License-Identifier: AGPL-3.0-only
-- Keep run history intact. Refuse inconsistent references before changing keys.

lock table public.model_calls, public.attempts, public.handback_reports,
           public.run_events, public.outage_runs, public.planned_steps,
           public.planned_runs, public.leases, public.reservations,
           public.conversations, public.people in share row exclusive mode;

do $$
declare
  bad_reference text;
begin
  select reference into bad_reference from (
    select 'model_calls.conversation_id' as reference
      from public.model_calls c
     where c.conversation_id is not null and not exists (
       select 1 from public.conversations p
        where p.business_id = c.business_id and p.id = c.conversation_id
     )
    union all
    select 'model_calls.outcome_person_id' as reference
      from public.model_calls c
     where c.outcome_person_id is not null and not exists (
       select 1 from public.people p
        where p.business_id = c.business_id and p.id = c.outcome_person_id
     )
    union all
    select 'attempts.step_id' as reference
      from public.attempts c
     where c.step_id is not null and not exists (
       select 1 from public.planned_steps p
        where p.business_id = c.business_id and p.run_id = c.run_id and p.id = c.step_id
     )
    union all
    select 'attempts.lease_id' as reference
      from public.attempts c
     where c.lease_id is not null and not exists (
       select 1 from public.leases p
        where p.business_id = c.business_id and p.run_id = c.run_id and p.id = c.lease_id
     )
    union all
    select 'attempts.reservation_id' as reference
      from public.attempts c
     where c.reservation_id is not null and not exists (
       select 1 from public.reservations p
        where p.business_id = c.business_id and p.run_id = c.run_id and p.id = c.reservation_id
     )
    union all
    select 'attempts.version_id' as reference
      from public.attempts c
     where c.version_id is not null and not exists (
       select 1 from public.planned_runs p
        where p.business_id = c.business_id and p.id = c.run_id and p.version_id = c.version_id
     )
    union all
    select 'attempts.envelope_id' as reference
      from public.attempts c
     where c.envelope_id is not null and not exists (
       select 1 from public.reservations p
        where p.business_id = c.business_id and p.run_id = c.run_id and p.id = c.reservation_id
          and p.envelope_id = c.envelope_id
     )
    union all
    select 'handback_reports.lease_id' as reference
      from public.handback_reports c
     where c.lease_id is not null and not exists (
       select 1 from public.leases p
        where p.business_id = c.business_id and p.run_id = c.run_id and p.id = c.lease_id
     )
    union all
    select 'handback_reports.reservation_id' as reference
      from public.handback_reports c
     where c.reservation_id is not null and not exists (
       select 1 from public.reservations p
        where p.business_id = c.business_id and p.run_id = c.run_id and p.id = c.reservation_id
     )
    union all
    select 'run_events.lease_id' as reference
      from public.run_events c
     where c.lease_id is not null and not exists (
       select 1 from public.leases p
        where p.business_id = c.business_id and p.run_id = c.run_id and p.id = c.lease_id
     )
    union all
    select 'run_events.attempt_id' as reference
      from public.run_events c
     where c.attempt_id is not null and not exists (
       select 1 from public.attempts p
        where p.business_id = c.business_id and p.run_id = c.run_id and p.id = c.attempt_id
     )
    union all
    select 'outage_runs.attempt_id' as reference
      from public.outage_runs c
     where c.attempt_id is not null and not exists (
       select 1 from public.attempts p
        where p.business_id = c.business_id and p.run_id = c.run_id and p.id = c.attempt_id
     )
  ) invalid limit 1;
  if bad_reference is not null then
    raise exception 'run-bound references: % contains orphaned or cross-scope rows', bad_reference
      using errcode = '23503';
  end if;
end;
$$;

alter table public.reservations
  add constraint reservations_run_envelope_key unique (business_id, run_id, id, envelope_id);

alter table public.model_calls
  add constraint model_calls_conversation_fkey foreign key (business_id, conversation_id)
    references public.conversations (business_id, id),
  add constraint model_calls_outcome_person_fkey foreign key (business_id, outcome_person_id)
    references public.people (business_id, id);

alter table public.attempts
  drop constraint attempts_version_fkey,
  add constraint attempts_run_in_version foreign key (business_id, run_id, version_id)
    references public.planned_runs (business_id, id, version_id),
  drop constraint attempts_envelope_fkey,
  add constraint attempts_envelope_fkey foreign key (business_id, run_id, reservation_id, envelope_id)
    references public.reservations (business_id, run_id, id, envelope_id);

alter table public.attempts
  drop constraint attempts_step_fkey,
  add constraint attempts_step_fkey foreign key (business_id, run_id, step_id)
    references public.planned_steps (business_id, run_id, id);

alter table public.attempts
  drop constraint attempts_lease_fkey,
  add constraint attempts_lease_fkey foreign key (business_id, run_id, lease_id)
    references public.leases (business_id, run_id, id);

alter table public.attempts
  drop constraint attempts_reservation_fkey,
  add constraint attempts_reservation_fkey foreign key (business_id, run_id, reservation_id)
    references public.reservations (business_id, run_id, id);

alter table public.handback_reports
  drop constraint handback_reports_lease_fkey,
  add constraint handback_reports_lease_fkey foreign key (business_id, run_id, lease_id)
    references public.leases (business_id, run_id, id);

alter table public.handback_reports
  drop constraint handback_reports_reservation_fkey,
  add constraint handback_reports_reservation_fkey foreign key (business_id, run_id, reservation_id)
    references public.reservations (business_id, run_id, id);

alter table public.run_events
  drop constraint run_events_lease_fkey,
  add constraint run_events_lease_fkey foreign key (business_id, run_id, lease_id)
    references public.leases (business_id, run_id, id);

alter table public.run_events
  drop constraint run_events_attempt_fkey,
  add constraint run_events_attempt_fkey foreign key (business_id, run_id, attempt_id)
    references public.attempts (business_id, run_id, id);

alter table public.outage_runs
  drop constraint outage_runs_attempt_fkey,
  add constraint outage_runs_attempt_fkey foreign key (business_id, run_id, attempt_id)
    references public.attempts (business_id, run_id, id);
