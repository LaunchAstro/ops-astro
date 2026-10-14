-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The agent login tool's acts (`scripts/ops/agent-login.ts`): one row for each
-- make, stop or restore of one agent's sign-in in one business. A make or a
-- restore is one generation of the login, whose address, custody item name and
-- provider subject are written once; a rerun resumes the row from its phase.
-- It holds no secret. Only the tool writes it, on the owner login: the
-- application group holds nothing on it, as with `ops.ended_subject_sessions`.

create table ops.agent_login_acts (
  business_id          uuid        not null,
  id                   uuid        not null default gen_random_uuid(),
  agent_actor_id       uuid        not null,
  act                  text        not null check (act in ('make', 'stop', 'restore')),
  generation           integer     check (generation >= 1),
  email                text        check (email ~ '^[^@[:space:]]+\+g[0-9]+@[^@[:space:]]+$'),
  custody_item         text        check (length(custody_item) between 1 and 200),
  provider_subject     text,
  login_id             uuid,
  phase                text        not null
    check (phase in ('reserved', 'user_made', 'bound', 'probed')),
  actor_was_active     boolean,
  actor_deactivated_at timestamptz,
  stopped_at           timestamptz,
  sessions_ended       boolean,
  ban                  text        check (ban in ('owed', 'done', 'shared')),
  ban_done_at          timestamptz,
  probe                text        check (probe = 'passed'),
  operator_person_id   uuid        not null,
  created_at           timestamptz not null default clock_timestamp(),
  updated_at           timestamptz not null default clock_timestamp(),
  closed_at            timestamptz,
  constraint agent_login_acts_pkey primary key (id),
  constraint agent_login_acts_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint agent_login_acts_agent_fkey foreign key (business_id, agent_actor_id)
    references public.actors (business_id, id),
  constraint agent_login_acts_login_fkey foreign key (business_id, login_id)
    references public.logins (business_id, id),
  constraint agent_login_acts_operator_fkey foreign key (business_id, operator_person_id)
    references public.people (business_id, id),
  constraint agent_login_acts_generation_values check (
    act = 'stop' or (generation is not null and email is not null and custody_item is not null)
  )
);

create unique index agent_login_acts_generation_idx
  on ops.agent_login_acts (business_id, agent_actor_id, generation)
  where act in ('make', 'restore');
-- At most one open act per agent: a second run resumes it, never starts another.
create unique index agent_login_acts_one_open_idx
  on ops.agent_login_acts (business_id, agent_actor_id) where closed_at is null;
-- One address is one generation of one agent, in every business.
create unique index agent_login_acts_email_idx
  on ops.agent_login_acts (lower(email)) where act in ('make', 'restore');

alter table ops.agent_login_acts enable row level security;
alter table ops.agent_login_acts force row level security;
create policy tenancy_agent_login_acts on ops.agent_login_acts
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_agent_login_acts on ops.agent_login_acts
  as permissive for all using (true) with check (true);
revoke all on ops.agent_login_acts from public;
