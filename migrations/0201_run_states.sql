-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0052 a run's state: its current knowledge and unknowns (MP-6-2, CS-16.4).
--
-- Each revision is a version, kept with the actor who revised it (`run:write`,
-- a person or an agent inside its delegation) and never rewritten, so the
-- agent page lists the revisions and the newest is the run's current state.
-- The keys hold a run on its own task in its own business, and one number is
-- one version. Knowledge and unknowns are arrays of the writer's text; the
-- command checks their items. No memory activates from them in version 1
-- (RA-10).

create table public.run_states (
  business_id         uuid        not null,
  id                  uuid        not null,
  run_id              uuid        not null,
  task_id             uuid        not null,
  version             integer     not null,
  knowledge           jsonb       not null,
  unknowns            jsonb       not null,
  revised_by_actor_id uuid        not null,
  revised_at          timestamptz not null default now(),
  constraint run_states_pkey primary key (id),
  constraint run_states_tenant_id_key unique (business_id, id),
  constraint run_states_run_version_key unique (business_id, run_id, version),
  constraint run_states_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint run_states_run_fkey foreign key (business_id, run_id, task_id)
    references public.planned_runs (business_id, id, task_id),
  constraint run_states_actor_fkey foreign key (business_id, revised_by_actor_id)
    references public.actors (business_id, id),
  constraint run_states_version_positive check (version > 0),
  constraint run_states_knowledge_array check (jsonb_typeof(knowledge) = 'array'),
  constraint run_states_unknowns_array check (jsonb_typeof(unknowns) = 'array')
);

create index run_states_business_idx on public.run_states (business_id);

alter table public.run_states enable row level security;
alter table public.run_states force row level security;

create policy tenancy_run_states on public.run_states
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_run_states on public.run_states
  as permissive
  for all
  using (true)
  with check (true);

-- It only raises, so it runs with its caller's rights, as run_checks' does.
create or replace function public.run_states_append_only()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  raise exception 'run_states is append only: version % cannot be %', old.id, lower(tg_op);
end;
$$;

revoke all on function public.run_states_append_only() from public;

create trigger run_states_no_update
  before update or delete on public.run_states
  for each row execute function public.run_states_append_only();

grant select, insert on public.run_states to ops_astro_app;
