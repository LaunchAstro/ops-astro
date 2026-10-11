-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Launch from the task: a person clicks Launch on a task held by an agent,
-- and a run is opened for that agent and task, waiting for the runner.
-- Assigning starts nothing (20261011090000); the click does.
--
-- Each row is one launch. It names the delegation the click minted for the
-- run, scoped to the task (`delegations.purpose_scope_id`), with the launcher
-- as the delegating person, so the run's authority is never wider than the
-- launcher's live grants on the task. The credential is not kept here, as it
-- is kept nowhere: it is derived from the key (`credential-keys.ts`).
--
-- `waiting` is open: the runner has not taken it. The runner moves it to
-- `started`, and either ends it. A waiting launch whose delegation lapsed is
-- ended at the next Launch on the task, under the task's lock. One open
-- launch per task, enforced below as a backstop to that check.
--
-- No function is added, so there is nothing to revoke from public.

create table public.task_launches (
  business_id          uuid        not null,
  id                   uuid        not null,
  task_id              uuid        not null,
  agent_actor_id       uuid        not null,
  delegation_id        uuid        not null,
  launched_by_actor_id uuid        not null,
  state                text        not null default 'waiting',
  launched_at          timestamptz not null default clock_timestamp(),
  ended_at             timestamptz,
  constraint task_launches_pkey primary key (id),
  constraint task_launches_tenant_id_key unique (business_id, id),
  constraint task_launches_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint task_launches_task_fkey foreign key (business_id, task_id)
    references public.records (business_id, id),
  constraint task_launches_agent_fkey foreign key (business_id, agent_actor_id)
    references public.actors (business_id, id),
  constraint task_launches_delegation_fkey foreign key (business_id, delegation_id)
    references public.delegations (business_id, id),
  constraint task_launches_launcher_fkey foreign key (business_id, launched_by_actor_id)
    references public.actors (business_id, id),
  constraint task_launches_state_known check (state in ('waiting', 'started', 'ended')),
  constraint task_launches_ended_when_ended check ((state = 'ended') = (ended_at is not null))
);

create unique index task_launches_one_open_idx
  on public.task_launches (business_id, task_id)
  where state <> 'ended';

create unique index task_launches_delegation_idx
  on public.task_launches (business_id, delegation_id);

alter table public.task_launches enable row level security;
alter table public.task_launches force row level security;

create policy tenancy_task_launches on public.task_launches
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_task_launches on public.task_launches
  as permissive
  for all
  using (true)
  with check (true);

-- No DELETE: a launch ends by its state, as a delegation ends by a timestamp.
grant select, insert, update on public.task_launches to ops_astro_app;
