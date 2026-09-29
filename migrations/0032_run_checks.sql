-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0032 the checks a run performs (MP-6-1, CS-16.3).
--
-- A check is a system write made under the run's worker lease: the row names
-- the lease it was written under, the holder of that lease as the actor that
-- performed it, and the version and run the lease works, so a person deciding
-- the gate reads each check against the exact version it ran on. The command
-- (`task.check`) refuses a caller holding no live lease before anything is
-- written; the keys below make a row that names a lease, run or version of
-- another business, or a run of another version, unwritable.
--
-- Append only, as `handback_reports` is: a check that can be edited after the
-- fact is not a record of what the run found.

create table public.run_checks (
  business_id uuid        not null,
  id          uuid        not null,
  task_id     uuid        not null,
  run_id      uuid        not null,
  version_id  uuid        not null,
  lease_id    uuid        not null,
  attempt_id  uuid        not null,
  actor_id    uuid        not null,
  fence       bigint      not null,
  name        text        not null,
  outcome     text        not null,
  note        text,
  created_at  timestamptz not null default now(),
  constraint run_checks_pkey primary key (id),
  constraint run_checks_tenant_id_key unique (business_id, id),
  constraint run_checks_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint run_checks_lease_fkey foreign key (business_id, lease_id)
    references public.leases (business_id, id),
  constraint run_checks_attempt_fkey foreign key (business_id, attempt_id)
    references public.attempts (business_id, id),
  constraint run_checks_actor_fkey foreign key (business_id, actor_id)
    references public.actors (business_id, id),
  constraint run_checks_version_fkey foreign key (business_id, version_id)
    references public.proposal_versions (business_id, id),
  -- The run is a run of the named version (`planned_runs` keys run and
  -- version together since 0021).
  constraint run_checks_run_in_version foreign key (business_id, run_id, version_id)
    references public.planned_runs (business_id, id, version_id),
  constraint run_checks_outcome_known check (outcome in ('passed', 'failed', 'inconclusive')),
  constraint run_checks_name_bounded check (char_length(name) between 1 and 120),
  constraint run_checks_note_bounded check (note is null or char_length(note) between 1 and 500)
);

create index run_checks_business_idx on public.run_checks (business_id);

create index run_checks_version_idx on public.run_checks (business_id, version_id, created_at);

alter table public.run_checks enable row level security;
alter table public.run_checks force row level security;

create policy tenancy_run_checks on public.run_checks
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_run_checks on public.run_checks
  as permissive
  for all
  using (true)
  with check (true);

-- It only raises, so it runs with its caller's rights: no second security
-- definer function (`handback_reports_append_only` stays the only one).
create or replace function public.run_checks_append_only()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  raise exception 'run_checks is append only: check % cannot be %', old.id, lower(tg_op);
end;
$$;

revoke all on function public.run_checks_append_only() from public;

create trigger run_checks_no_update
  before update or delete on public.run_checks
  for each row execute function public.run_checks_append_only();

grant select, insert on public.run_checks to ops_astro_app;
