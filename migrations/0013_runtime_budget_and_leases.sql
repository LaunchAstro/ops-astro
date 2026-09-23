-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0013 money and claim: the cap, the task envelope with its two totals, the
-- reservation that holds against it, and the fenced lease that claims the work.
--
-- **Held and actual are two columns, not one.** A reservation holds an amount
-- before the work happens and an actual lands after it. Collapsing them makes
-- "what is committed" and "what was spent" the same number, and the difference
-- between them is the only thing that tells a reservation that was abandoned
-- from one that completed at zero. W03 says the lease and the money are
-- separate facts; this is where that separation is stored.
--
-- **A reservation's first-head terminal state is `abandoned`, never a zero
-- `actual`** (transaction contract, finite reachable lifecycle). A released
-- hold that writes `actual_minor = 0` is a claim that the work ran and cost
-- nothing. Nothing in this head runs, so that claim would be an invention.
--
-- **The lease is fenced.** `fence` is monotonic per task, and a handback
-- presenting a fence lower than the task's current one changes nothing (W02).
-- Expiry alone does not release; the replacement acquires the next fence and
-- the old identity is fenced out, so a late report from the old holder can be
-- retained without letting it settle the replacement's work.
--
-- `reservations.lease_id` is nullable and that is deliberate, not a gap: T2
-- creates the reservation at the decision and T3 binds it to a lease at
-- pickup. A crash between the two leaves a held, claimable, unleased
-- reservation, which is exactly the state T5's classifier must leave alone.

-- ---------------------------------------------------------------------------
-- The cap.
-- ---------------------------------------------------------------------------

create table public.budget_caps (
  business_id   uuid        not null,
  id            uuid        not null,
  key           text        not null,
  limit_minor   bigint      not null,
  currency      text        not null,
  created_at    timestamptz not null default now(),
  constraint budget_caps_pkey primary key (id),
  constraint budget_caps_tenant_id_key unique (business_id, id),
  constraint budget_caps_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint budget_caps_limit_positive check (limit_minor > 0)
);

create unique index budget_caps_key_idx on public.budget_caps (business_id, key);

create index budget_caps_business_idx on public.budget_caps (business_id);

alter table public.budget_caps enable row level security;
alter table public.budget_caps force row level security;

create policy tenancy_budget_caps on public.budget_caps
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_budget_caps on public.budget_caps
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update on public.budget_caps to ops_astro_app;

-- ---------------------------------------------------------------------------
-- The task envelope.
-- ---------------------------------------------------------------------------

create table public.task_envelopes (
  business_id   uuid        not null,
  id            uuid        not null,
  cap_id        uuid        not null,
  task_id       uuid        not null,
  state         text        not null default 'open',
  maximum_minor bigint      not null,
  held_minor    bigint      not null default 0,
  actual_minor  bigint      not null default 0,
  currency      text        not null,
  opened_at     timestamptz not null default now(),
  closed_at     timestamptz,
  constraint task_envelopes_pkey primary key (id),
  constraint task_envelopes_tenant_id_key unique (business_id, id),
  constraint task_envelopes_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint task_envelopes_cap_fkey foreign key (business_id, cap_id)
    references public.budget_caps (business_id, id),
  constraint task_envelopes_task_fkey foreign key (business_id, task_id)
    references public.records (business_id, id),
  constraint task_envelopes_state_known check (state in ('open', 'closed')),
  constraint task_envelopes_closed_is_dated check ((state = 'open') = (closed_at is null)),
  -- Neither total may go negative. A double release shows up here as a
  -- constraint violation rather than as a quietly wrong number, which is what
  -- W03's "double release" case is watching for.
  constraint task_envelopes_held_not_negative check (held_minor >= 0),
  constraint task_envelopes_actual_not_negative check (actual_minor >= 0),
  -- The ceiling covers both together. W05's "cannot exceed the envelope" is
  -- this line; the code refuses first so the caller gets a reason, and this
  -- refuses second so a caller that got around the code gets nothing.
  constraint task_envelopes_within_maximum check (held_minor + actual_minor <= maximum_minor)
);

create unique index task_envelopes_task_open_idx
  on public.task_envelopes (business_id, task_id)
  where state = 'open';

create index task_envelopes_business_idx on public.task_envelopes (business_id);

create index task_envelopes_cap_idx on public.task_envelopes (business_id, cap_id);

alter table public.task_envelopes enable row level security;
alter table public.task_envelopes force row level security;

create policy tenancy_task_envelopes on public.task_envelopes
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_task_envelopes on public.task_envelopes
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update on public.task_envelopes to ops_astro_app;

-- ---------------------------------------------------------------------------
-- The reservation.
-- ---------------------------------------------------------------------------

create table public.reservations (
  business_id     uuid        not null,
  id              uuid        not null,
  envelope_id     uuid        not null,
  version_id      uuid        not null,
  run_id          uuid        not null,
  lease_id        uuid,
  state           text        not null default 'held',
  held_minor      bigint      not null,
  actual_minor    bigint,
  classified_cause text,
  classified_cause_id uuid,
  created_at      timestamptz not null default now(),
  terminal_at     timestamptz,
  constraint reservations_pkey primary key (id),
  constraint reservations_tenant_id_key unique (business_id, id),
  constraint reservations_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint reservations_envelope_fkey foreign key (business_id, envelope_id)
    references public.task_envelopes (business_id, id),
  constraint reservations_version_fkey foreign key (business_id, version_id)
    references public.proposal_versions (business_id, id),
  constraint reservations_run_fkey foreign key (business_id, run_id)
    references public.planned_runs (business_id, id),
  constraint reservations_state_known
    check (state in ('held', 'abandoned', 'actual', 'quarantined')),
  constraint reservations_held_positive check (held_minor > 0),
  constraint reservations_terminal_is_dated
    check ((state in ('held', 'quarantined')) = (terminal_at is null)),
  -- `actual` carries a number; `abandoned` carries none. This is the line that
  -- makes "abandoned, not a fake zero-cost settlement" a fact about the row
  -- rather than a sentence in a document.
  constraint reservations_actual_only_when_actual
    check ((state = 'actual') = (actual_minor is not null)),
  -- An abandonment names what made this exact attempt nonclaimable (T5). A
  -- release with no recorded cause is the startup-abandons-claimable-work
  -- failure W04 refuses.
  constraint reservations_abandoned_has_cause
    check ((state = 'abandoned') = (classified_cause is not null))
);

-- One reservation per version. A second hold on one approved version is the
-- duplicate hold W01's kill-after-commit retry case is watching for.
create unique index reservations_version_idx on public.reservations (business_id, version_id);

create index reservations_business_idx on public.reservations (business_id);

create index reservations_envelope_idx on public.reservations (business_id, envelope_id);

-- The queue projection reads this: approved, held, unpicked.
create index reservations_unleased_idx
  on public.reservations (business_id, state)
  where lease_id is null and state = 'held';

alter table public.reservations enable row level security;
alter table public.reservations force row level security;

create policy tenancy_reservations on public.reservations
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_reservations on public.reservations
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update on public.reservations to ops_astro_app;

-- ---------------------------------------------------------------------------
-- The fenced lease.
-- ---------------------------------------------------------------------------

create table public.leases (
  business_id     uuid        not null,
  id              uuid        not null,
  task_id         uuid        not null,
  run_id          uuid        not null,
  reservation_id  uuid        not null,
  delegation_id   uuid,
  holder_actor_id uuid        not null,
  authorised_by_person_id uuid not null,
  fence           bigint      not null,
  state           text        not null default 'live',
  acquired_at     timestamptz not null default now(),
  expires_at      timestamptz not null,
  released_at     timestamptz,
  constraint leases_pkey primary key (id),
  constraint leases_tenant_id_key unique (business_id, id),
  constraint leases_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint leases_task_fkey foreign key (business_id, task_id)
    references public.records (business_id, id),
  constraint leases_run_fkey foreign key (business_id, run_id)
    references public.planned_runs (business_id, id),
  constraint leases_reservation_fkey foreign key (business_id, reservation_id)
    references public.reservations (business_id, id),
  constraint leases_delegation_fkey foreign key (business_id, delegation_id)
    references public.delegations (business_id, id),
  constraint leases_holder_fkey foreign key (business_id, holder_actor_id)
    references public.actors (business_id, id),
  constraint leases_authorised_by_fkey foreign key (business_id, authorised_by_person_id)
    references public.people (business_id, id),
  constraint leases_state_known check (state in ('live', 'released', 'expired')),
  constraint leases_released_is_dated check ((state = 'live') = (released_at is null)),
  constraint leases_fence_positive check (fence > 0)
);

-- One live lease per task. `task.pickup` refuses LEASE_HELD before it reaches
-- this, and this refuses a pickup that got around the refusal.
create unique index leases_one_live_per_task_idx
  on public.leases (business_id, task_id)
  where state = 'live';

-- The fence is monotonic per task, so it is also unique per task. A
-- replacement that reused the old number would let a late handback from the
-- old holder settle the new holder's work.
create unique index leases_fence_idx on public.leases (business_id, task_id, fence);

create index leases_business_idx on public.leases (business_id);

alter table public.leases enable row level security;
alter table public.leases force row level security;

create policy tenancy_leases on public.leases
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_leases on public.leases
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update on public.leases to ops_astro_app;

-- Declared last, because the two tables reference each other: a reservation
-- names the lease that claimed it, and a lease names the reservation it
-- claimed. Neither can be created with the other's constraint already in
-- place.
alter table public.reservations
  add constraint reservations_lease_fkey foreign key (business_id, lease_id)
    references public.leases (business_id, id);
