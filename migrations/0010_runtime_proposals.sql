-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0010 runtime proposals. The lineage a proposal lives in, the immutable
-- digest-bound versions inside it, the real planned run and its steps, and the
-- evidence pack rendered from those stored facts.
--
-- Four things here are deliberate and are the contract rather than a schema
-- preference (TRANSACTION-CONTRACT.md, T1).
--
-- A **version is immutable.** Its payload and digest cannot be updated, and a
-- row cannot be deleted. G04 says a successor version resets eligibility while
-- retaining prior decisions; that is only true if the version a decision named
-- still says what it said when the decision was signed over it. An updatable
-- payload makes every historical signature a claim about bytes that are gone.
--
-- A **run and a step are planned local work, never an observed effect.** No
-- first-head path marks dispatch, and `planned_steps.dispatched_at` carries a
-- check that keeps it null. A later unit that activates dispatch drops that
-- check deliberately and reruns the proofs; it cannot arrive by a handler
-- quietly writing a timestamp (transaction contract, finite reachable
-- lifecycle).
--
-- An **evidence pack is rendered, not supplied.** It stores the digest of the
-- version it was rendered for, so G07's "approve binds the same hash" is a
-- comparison against a stored fact rather than trust in the renderer's caller.
--
-- Every table inherits 0001's four rules and does not restate them:
-- `business_id not null` through the tenant unique key, row security enabled
-- AND forced, one restrictive tenancy policy plus a permissive baseline, and
-- composite foreign keys leading with `business_id` on both sides.

-- ---------------------------------------------------------------------------
-- The lineage: one line of proposals about one task.
-- ---------------------------------------------------------------------------

-- Versions supersede each other *within* a lineage; a rejection makes the
-- lineage terminal and an authorised restart opens a new one (G05, T6). So the
-- terminal fact lives here and not on a version, because "this line of work is
-- over" is not a property of any one version of it.
create table public.proposal_lineages (
  business_id      uuid        not null,
  id               uuid        not null,
  task_id          uuid        not null,
  state            text        not null default 'live',
  terminal_reason  text,
  opened_by_actor_id uuid      not null,
  restarts_lineage_id uuid,
  created_at       timestamptz not null default now(),
  terminal_at      timestamptz,
  constraint proposal_lineages_pkey primary key (id),
  constraint proposal_lineages_tenant_id_key unique (business_id, id),
  constraint proposal_lineages_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint proposal_lineages_task_fkey foreign key (business_id, task_id)
    references public.records (business_id, id),
  constraint proposal_lineages_opened_by_fkey foreign key (business_id, opened_by_actor_id)
    references public.actors (business_id, id),
  constraint proposal_lineages_restarts_fkey foreign key (business_id, restarts_lineage_id)
    references public.proposal_lineages (business_id, id),
  constraint proposal_lineages_state_known
    check (state in ('live', 'rejected', 'cancelled', 'completed')),
  -- A terminal lineage carries why and when; a live one carries neither. The
  -- alternative is a row that is terminal according to one column and live
  -- according to another, and the reader picks.
  constraint proposal_lineages_terminal_is_dated
    check ((state = 'live') = (terminal_at is null)),
  constraint proposal_lineages_terminal_has_reason
    check ((state = 'live') = (terminal_reason is null))
);

alter table public.proposal_lineages enable row level security;
alter table public.proposal_lineages force row level security;

create policy tenancy_proposal_lineages on public.proposal_lineages
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_proposal_lineages on public.proposal_lineages
  as permissive
  for all
  using (true)
  with check (true);

create index proposal_lineages_task_idx on public.proposal_lineages (business_id, task_id);

grant select, insert, update on public.proposal_lineages to ops_astro_app;

-- ---------------------------------------------------------------------------
-- The version: immutable, digest-bound.
-- ---------------------------------------------------------------------------

create table public.proposal_versions (
  business_id        uuid        not null,
  id                 uuid        not null,
  lineage_id         uuid        not null,
  version            integer     not null,
  payload            jsonb       not null,
  payload_digest     text        not null,
  purpose            text        not null,
  maximum_minor      bigint      not null,
  currency           text        not null,
  proposed_by_actor_id uuid      not null,
  created_at         timestamptz not null default now(),
  superseded_at      timestamptz,
  constraint proposal_versions_pkey primary key (id),
  constraint proposal_versions_tenant_id_key unique (business_id, id),
  constraint proposal_versions_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint proposal_versions_lineage_fkey foreign key (business_id, lineage_id)
    references public.proposal_lineages (business_id, id),
  constraint proposal_versions_proposed_by_fkey foreign key (business_id, proposed_by_actor_id)
    references public.actors (business_id, id),
  constraint proposal_versions_numbered check (version >= 1),
  constraint proposal_versions_digest_shaped check (payload_digest ~ '^[0-9a-f]{64}$'),
  -- The same shape `delegations.purpose` carries in 0008, and for the same
  -- reason: pickup mints a delegation on this exact purpose, so a proposal
  -- whose purpose the delegation could not hold has to be refused here, at
  -- propose time, rather than at pickup with a constraint violation the
  -- proposer never sees.
  constraint proposal_versions_purpose_shape check (purpose ~ '^[a-z][a-z0-9_]{0,62}$'),
  -- A bounded attempt with no ceiling is not bounded. W05 needs a finite
  -- maximum to reserve against, and the place it becomes finite is here.
  constraint proposal_versions_maximum_positive check (maximum_minor > 0)
);

create unique index proposal_versions_lineage_version_idx
  on public.proposal_versions (business_id, lineage_id, version);

-- One live version per lineage. A second unsuperseded version would make
-- "the current version" a question about insertion order.
create unique index proposal_versions_one_live_idx
  on public.proposal_versions (business_id, lineage_id)
  where superseded_at is null;

create index proposal_versions_business_idx on public.proposal_versions (business_id);

-- What a version says cannot change. `superseded_at` is the one column an
-- update may set, and only from null: superseding is a fact added to the row,
-- not a rewriting of it. A decision signed over this payload has to keep
-- meaning what it meant.
create function public.proposal_versions_are_immutable() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'proposal_versions are immutable: version % cannot be deleted', old.id
      using errcode = 'restrict_violation';
  end if;
  if new.id is distinct from old.id
     or new.business_id is distinct from old.business_id
     or new.lineage_id is distinct from old.lineage_id
     or new.version is distinct from old.version
     or new.payload is distinct from old.payload
     or new.payload_digest is distinct from old.payload_digest
     or new.purpose is distinct from old.purpose
     or new.maximum_minor is distinct from old.maximum_minor
     or new.currency is distinct from old.currency
     or new.proposed_by_actor_id is distinct from old.proposed_by_actor_id
     or new.created_at is distinct from old.created_at then
    raise exception 'proposal_versions are immutable: version % cannot be edited', old.id
      using errcode = 'restrict_violation';
  end if;
  if old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at then
    raise exception 'version % is already superseded', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.proposal_versions_are_immutable() from public;

create trigger proposal_versions_immutable
  before update or delete on public.proposal_versions
  for each row execute function public.proposal_versions_are_immutable();

alter table public.proposal_versions enable row level security;
alter table public.proposal_versions force row level security;

create policy tenancy_proposal_versions on public.proposal_versions
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_proposal_versions on public.proposal_versions
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update on public.proposal_versions to ops_astro_app;

-- ---------------------------------------------------------------------------
-- The planned run and its steps.
-- ---------------------------------------------------------------------------

create table public.planned_runs (
  business_id  uuid        not null,
  id           uuid        not null,
  lineage_id   uuid        not null,
  version_id   uuid        not null,
  task_id      uuid        not null,
  state        text        not null default 'planned',
  created_at   timestamptz not null default now(),
  constraint planned_runs_pkey primary key (id),
  constraint planned_runs_tenant_id_key unique (business_id, id),
  constraint planned_runs_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint planned_runs_lineage_fkey foreign key (business_id, lineage_id)
    references public.proposal_lineages (business_id, id),
  constraint planned_runs_version_fkey foreign key (business_id, version_id)
    references public.proposal_versions (business_id, id),
  constraint planned_runs_task_fkey foreign key (business_id, task_id)
    references public.records (business_id, id),
  constraint planned_runs_state_known
    check (state in ('planned', 'claimed', 'handed_back', 'cancelled'))
);

-- One run per version. G01's "non-null run/step" is only worth asserting if
-- the reference is also unambiguous.
create unique index planned_runs_version_idx on public.planned_runs (business_id, version_id);

create index planned_runs_business_idx on public.planned_runs (business_id);

alter table public.planned_runs enable row level security;
alter table public.planned_runs force row level security;

create policy tenancy_planned_runs on public.planned_runs
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_planned_runs on public.planned_runs
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update on public.planned_runs to ops_astro_app;

create table public.planned_steps (
  business_id   uuid        not null,
  id            uuid        not null,
  run_id        uuid        not null,
  ordinal       integer     not null,
  kind          text        not null,
  payload       jsonb       not null,
  dispatched_at timestamptz,
  created_at    timestamptz not null default now(),
  constraint planned_steps_pkey primary key (id),
  constraint planned_steps_tenant_id_key unique (business_id, id),
  constraint planned_steps_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint planned_steps_run_fkey foreign key (business_id, run_id)
    references public.planned_runs (business_id, id),
  constraint planned_steps_ordered check (ordinal >= 1),
  -- This head exports no dispatch. The absence is a constraint rather than a
  -- convention, so activating dispatch is a migration somebody reviews.
  constraint planned_steps_undispatched check (dispatched_at is null)
);

create unique index planned_steps_run_ordinal_idx
  on public.planned_steps (business_id, run_id, ordinal);

create index planned_steps_business_idx on public.planned_steps (business_id);

alter table public.planned_steps enable row level security;
alter table public.planned_steps force row level security;

create policy tenancy_planned_steps on public.planned_steps
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_planned_steps on public.planned_steps
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update on public.planned_steps to ops_astro_app;

-- ---------------------------------------------------------------------------
-- The evidence pack.
-- ---------------------------------------------------------------------------

-- Rendered by production code from the run, the step and the version, before
-- the gate exists (G07). It stores the digest it was rendered against so the
-- decision can compare rather than trust, and it is one row per version so a
-- stale pack cannot sit beside a fresh one.
create table public.evidence_packs (
  business_id    uuid        not null,
  id             uuid        not null,
  version_id     uuid        not null,
  run_id         uuid        not null,
  rendered       jsonb       not null,
  rendered_digest text       not null,
  version_digest text        not null,
  renderer       text        not null,
  rendered_at    timestamptz not null default now(),
  constraint evidence_packs_pkey primary key (id),
  constraint evidence_packs_tenant_id_key unique (business_id, id),
  constraint evidence_packs_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint evidence_packs_version_fkey foreign key (business_id, version_id)
    references public.proposal_versions (business_id, id),
  constraint evidence_packs_run_fkey foreign key (business_id, run_id)
    references public.planned_runs (business_id, id),
  constraint evidence_packs_digest_shaped check (rendered_digest ~ '^[0-9a-f]{64}$'),
  constraint evidence_packs_version_digest_shaped check (version_digest ~ '^[0-9a-f]{64}$'),
  -- An empty pack is the fixture shortcut G07 names. `'{}'::jsonb` and `'[]'`
  -- and `'null'` are all things a test could insert instead of rendering.
  constraint evidence_packs_not_empty
    check (jsonb_typeof(rendered) = 'object' and rendered <> '{}'::jsonb)
);

create unique index evidence_packs_version_idx on public.evidence_packs (business_id, version_id);

create index evidence_packs_business_idx on public.evidence_packs (business_id);

alter table public.evidence_packs enable row level security;
alter table public.evidence_packs force row level security;

create policy tenancy_evidence_packs on public.evidence_packs
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_evidence_packs on public.evidence_packs
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert on public.evidence_packs to ops_astro_app;
