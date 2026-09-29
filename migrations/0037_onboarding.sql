-- SPDX-License-Identifier: AGPL-3.0-only
--
-- New client onboarding (C41-A, U38, CS-15.2 and CS-15.4).
--
-- An onboarding is one client laid out as tasks from one template version.
-- The template is versioned in code and never edited in place, so the row
-- names the version it was laid out from. Each step is a task on the client
-- (its party link) plus a step row here: its phase, whether an agent runs it,
-- a person does it or it waits on the client, the steps it depends on, and how
-- many times it failed. Two failures stop the onboarding; the stop is a state,
-- never a deletion.
--
-- One onboarding per client, held by the database. The client is a record of
-- the `client` record type; the tasks are ordinary task records, so they are
-- read, shared and trashed like any other.

create table public.onboardings (
  business_id          uuid        not null,
  id                   uuid        not null,
  client_id            uuid        not null,
  template_key         text        not null,
  template_version     integer     not null,
  state                text        not null default 'running',
  started_by_actor_id  uuid        not null,
  started_at           timestamptz not null default now(),
  stopped_at           timestamptz,
  revision             bigint      not null default 1,
  constraint onboardings_pkey primary key (id),
  constraint onboardings_tenant_id_key unique (business_id, id),
  constraint onboardings_one_per_client unique (business_id, client_id),
  constraint onboardings_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint onboardings_client_fkey foreign key (business_id, client_id)
    references public.records (business_id, id),
  constraint onboardings_starter_fkey foreign key (business_id, started_by_actor_id)
    references public.actors (business_id, id),
  constraint onboardings_template_key_shape check (template_key ~ '^[a-z][a-z0-9-]{0,62}$'),
  constraint onboardings_template_version_positive check (template_version >= 1),
  constraint onboardings_state_known check (state in ('running', 'stopped', 'done')),
  constraint onboardings_stopped_when_stopped check ((state = 'stopped') = (stopped_at is not null)),
  constraint onboardings_revision_positive check (revision >= 1)
);

create table public.onboarding_steps (
  business_id    uuid        not null,
  onboarding_id  uuid        not null,
  step_key       text        not null,
  task_id        uuid        not null,
  position       integer     not null,
  phase          text        not null,
  kind           text        not null,
  depends_on     text[]      not null default '{}',
  state          text        not null,
  failures       integer     not null default 0,
  closed_at      timestamptz,
  constraint onboarding_steps_pkey primary key (business_id, onboarding_id, step_key),
  constraint onboarding_steps_one_task unique (business_id, task_id),
  constraint onboarding_steps_onboarding_fkey foreign key (business_id, onboarding_id)
    references public.onboardings (business_id, id),
  constraint onboarding_steps_task_fkey foreign key (business_id, task_id)
    references public.records (business_id, id),
  constraint onboarding_steps_key_shape check (step_key ~ '^[a-z][a-z0-9-]{0,62}$'),
  constraint onboarding_steps_phase_length check (char_length(phase) between 1 and 80),
  constraint onboarding_steps_kind_known check (kind in ('agent', 'person', 'client')),
  constraint onboarding_steps_state_known
    check (state in ('blocked', 'ready', 'done', 'stopped')),
  constraint onboarding_steps_failures_bounded check (failures between 0 and 2),
  constraint onboarding_steps_closed_when_done check ((state = 'done') = (closed_at is not null)),
  constraint onboarding_steps_depends_listed check (array_position(depends_on, null) is null)
);

alter table public.onboardings enable row level security;
alter table public.onboardings force row level security;
alter table public.onboarding_steps enable row level security;
alter table public.onboarding_steps force row level security;

create policy tenancy_onboardings on public.onboardings
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_onboardings on public.onboardings
  as permissive for all using (true) with check (true);

create policy tenancy_onboarding_steps on public.onboarding_steps
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_onboarding_steps on public.onboarding_steps
  as permissive for all using (true) with check (true);

grant select, insert, update (state, stopped_at, revision) on public.onboardings to ops_astro_app;
grant select, insert, update (state, failures, closed_at) on public.onboarding_steps to ops_astro_app;
