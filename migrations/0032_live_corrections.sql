-- SPDX-License-Identifier: AGPL-3.0-only
--
-- C80: the live correction and its receipts.
--
-- One row per requested one-word change on a catalogued page. The request pins
-- everything the publish is later judged against (the target, the pre-image
-- digest, the base revision, the proposal's version and digest, the seam the
-- outcome is read back by), so the approval binds to the exact version and a
-- later drift is a refusal, never a silent re-base.
--
-- The requester is recorded as a person as well as an actor: an agent asks
-- inside a delegation, and the person it acts for is the one who may not
-- approve (release decision 3.4). The check below is the storage half of that
-- rule; the command refuses first, with its own code.
--
-- `party_id` is the party the site belongs to. It is the scope the grants are
-- asked at, so a party-scoped grant on one client's site reaches no other
-- client's correction.

create table public.live_corrections (
  business_id            uuid        not null,
  id                     uuid        not null,
  party_id               uuid        not null,
  task_id                uuid        not null,
  requested_by_actor_id  uuid        not null,
  requested_by_person_id uuid        not null,
  delegation_id          uuid,
  target_path            text        not null,
  word                   text        not null,
  replacement            text        not null,
  page_url               text        not null,
  pre_image_digest       text        not null,
  base_revision          text        not null,
  seam                   text        not null,
  version_id             uuid        not null,
  version_digest         text        not null,
  state                  text        not null default 'requested',
  decided_by_actor_id    uuid,
  decided_by_person_id   uuid,
  decided_at             timestamptz,
  revision               integer     not null default 1,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint live_corrections_pkey primary key (id),
  constraint live_corrections_tenant_id_key unique (business_id, id),
  constraint live_corrections_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint live_corrections_task_fkey foreign key (business_id, task_id)
    references public.records (business_id, id),
  constraint live_corrections_requested_by_actor_fkey
    foreign key (business_id, requested_by_actor_id) references public.actors (business_id, id),
  constraint live_corrections_requested_by_person_fkey
    foreign key (business_id, requested_by_person_id) references public.people (business_id, id),
  constraint live_corrections_delegation_fkey foreign key (business_id, delegation_id)
    references public.delegations (business_id, id),
  constraint live_corrections_decided_by_actor_fkey
    foreign key (business_id, decided_by_actor_id) references public.actors (business_id, id),
  constraint live_corrections_decided_by_person_fkey
    foreign key (business_id, decided_by_person_id) references public.people (business_id, id),
  constraint live_corrections_state_known check (state in (
    'requested', 'approved', 'rejected', 'cancelled',
    'accepted', 'live', 'unknown', 'failed', 'reverted'
  )),
  constraint live_corrections_decision_whole check (
    (decided_by_actor_id is null) = (decided_by_person_id is null)
    and (decided_by_actor_id is null) = (decided_at is null)
  ),
  constraint live_corrections_decided_before_effect check (
    state in ('requested', 'cancelled') or decided_by_person_id is not null
  ),
  constraint live_corrections_no_self_approval
    check (decided_by_person_id is distinct from requested_by_person_id),
  constraint live_corrections_revision_positive check (revision >= 1)
);

create index live_corrections_business_idx on public.live_corrections (business_id);
create index live_corrections_party_idx on public.live_corrections (business_id, party_id);

alter table public.live_corrections enable row level security;
alter table public.live_corrections force row level security;

create policy tenancy_live_corrections on public.live_corrections
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_live_corrections on public.live_corrections
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update on public.live_corrections to ops_astro_app;

-- What a request pinned stays pinned: an approval names this row's version,
-- and a version whose target, word, digests or seam could change after the
-- decision would be an approval of something else. Only the state, the
-- decision and the revision move. Invoker: raising needs no privilege.
create or replace function public.live_corrections_pinned()
  returns trigger
  language plpgsql
  security invoker
  set search_path = pg_catalog, public
as $$
begin
  if (new.business_id, new.id, new.party_id, new.task_id, new.requested_by_actor_id,
      new.requested_by_person_id, new.delegation_id, new.target_path, new.word,
      new.replacement, new.page_url, new.pre_image_digest, new.base_revision, new.seam,
      new.version_id, new.version_digest, new.created_at)
     is distinct from
     (old.business_id, old.id, old.party_id, old.task_id, old.requested_by_actor_id,
      old.requested_by_person_id, old.delegation_id, old.target_path, old.word,
      old.replacement, old.page_url, old.pre_image_digest, old.base_revision, old.seam,
      old.version_id, old.version_digest, old.created_at) then
    raise exception 'live_corrections_pinned: correction % keeps what it pinned', old.id;
  end if;
  return new;
end;
$$;

revoke all on function public.live_corrections_pinned() from public;

create trigger live_corrections_pinned
  before update on public.live_corrections
  for each row execute function public.live_corrections_pinned();

-- Receipt L's observations of one publish or revert, written by the system
-- under the worker lease in the transaction that records the observed result.
-- Append only: a receipt is evidence, and evidence that can be rewritten is not.
create table public.live_correction_receipts (
  business_id    uuid        not null,
  id             uuid        not null,
  correction_id  uuid        not null,
  lease_id       uuid        not null,
  fence          bigint      not null,
  step           text        not null,
  outcome        text        not null,
  observations   jsonb       not null,
  created_at     timestamptz not null default now(),
  constraint live_correction_receipts_pkey primary key (id),
  constraint live_correction_receipts_tenant_id_key unique (business_id, id),
  constraint live_correction_receipts_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint live_correction_receipts_correction_fkey foreign key (business_id, correction_id)
    references public.live_corrections (business_id, id),
  constraint live_correction_receipts_lease_fkey foreign key (business_id, lease_id)
    references public.leases (business_id, id),
  constraint live_correction_receipts_step_known check (step in ('publish', 'revert')),
  constraint live_correction_receipts_outcome_known
    check (outcome in ('accepted', 'live', 'unknown', 'failed', 'reverted')),
  constraint live_correction_receipts_observations_object
    check (jsonb_typeof(observations) = 'object')
);

create index live_correction_receipts_correction_idx
  on public.live_correction_receipts (business_id, correction_id);

alter table public.live_correction_receipts enable row level security;
alter table public.live_correction_receipts force row level security;

create policy tenancy_live_correction_receipts on public.live_correction_receipts
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_live_correction_receipts on public.live_correction_receipts
  as permissive
  for all
  using (true)
  with check (true);

-- Invoker, not definer: raising needs no privilege, and the definer set stays
-- the one the restricted-calls suite pins.
create or replace function public.live_correction_receipts_append_only()
  returns trigger
  language plpgsql
  security invoker
  set search_path = pg_catalog, public
as $$
begin
  raise exception 'live_correction_receipts is append only: receipt % cannot be %',
    old.id, lower(tg_op);
end;
$$;

revoke all on function public.live_correction_receipts_append_only() from public;

create trigger live_correction_receipts_no_update
  before update or delete on public.live_correction_receipts
  for each row execute function public.live_correction_receipts_append_only();

grant select, insert on public.live_correction_receipts to ops_astro_app;
