-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0035 what a run knows so far, versioned (MP-6-2, CS-16.4).
--
-- `state revised` is the run recording its current knowledge: what is
-- currently valid, what it does not know, which inputs have gone stale, and
-- the step that last contributed. Each revision is a new row, numbered per
-- run, never an edit: the run's current knowledge is its newest, and every
-- earlier one stays with its actor. Like `run_checks`, it is written under the
-- run's worker lease: the row names the lease, the lease holder as its actor,
-- and the run and version the lease works, never a body's claim. The command
-- (`run.revise_state`, `run:write`) takes the lease lock before numbering, and
-- the unique key below is the backstop: two revisions of one run can never
-- share a number.
--
-- Nothing here is memory. A revision belongs to its run and no other run
-- reads it (RA-10: no memory activates in version 1).

create table public.run_state_revisions (
  business_id uuid        not null,
  id          uuid        not null,
  task_id     uuid        not null,
  run_id      uuid        not null,
  version_id  uuid        not null,
  lease_id    uuid        not null,
  attempt_id  uuid        not null,
  actor_id    uuid        not null,
  fence       bigint      not null,
  revision    integer     not null,
  step        text,
  valid       jsonb       not null,
  unknowns    jsonb       not null,
  stale       jsonb       not null,
  created_at  timestamptz not null default now(),
  constraint run_state_revisions_pkey primary key (id),
  constraint run_state_revisions_tenant_id_key unique (business_id, id),
  constraint run_state_revisions_numbered unique (business_id, run_id, revision),
  constraint run_state_revisions_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint run_state_revisions_lease_fkey foreign key (business_id, lease_id)
    references public.leases (business_id, id),
  constraint run_state_revisions_attempt_fkey foreign key (business_id, attempt_id)
    references public.attempts (business_id, id),
  constraint run_state_revisions_actor_fkey foreign key (business_id, actor_id)
    references public.actors (business_id, id),
  constraint run_state_revisions_version_fkey foreign key (business_id, version_id)
    references public.proposal_versions (business_id, id),
  constraint run_state_revisions_run_in_version foreign key (business_id, run_id, version_id)
    references public.planned_runs (business_id, id, version_id),
  constraint run_state_revisions_revision_positive check (revision >= 1),
  constraint run_state_revisions_step_bounded
    check (step is null or char_length(step) between 1 and 120),
  constraint run_state_revisions_lists
    check (jsonb_typeof(valid) = 'array' and jsonb_array_length(valid) <= 40
       and jsonb_typeof(unknowns) = 'array' and jsonb_array_length(unknowns) <= 40
       and jsonb_typeof(stale) = 'array' and jsonb_array_length(stale) <= 40)
);

create index run_state_revisions_business_idx on public.run_state_revisions (business_id);

create index run_state_revisions_version_idx
  on public.run_state_revisions (business_id, version_id, revision);

alter table public.run_state_revisions enable row level security;
alter table public.run_state_revisions force row level security;

create policy tenancy_run_state_revisions on public.run_state_revisions
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_run_state_revisions on public.run_state_revisions
  as permissive
  for all
  using (true)
  with check (true);

-- It only raises, so it runs with its caller's rights, as
-- `run_checks_append_only` does.
create or replace function public.run_state_revisions_append_only()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  raise exception 'run_state_revisions is append only: revision % cannot be %', old.id, lower(tg_op);
end;
$$;

revoke all on function public.run_state_revisions_append_only() from public;

create trigger run_state_revisions_no_update
  before update or delete on public.run_state_revisions
  for each row execute function public.run_state_revisions_append_only();

grant select, insert on public.run_state_revisions to ops_astro_app;
