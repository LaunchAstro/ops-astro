-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0014 the attempt. Immutable provenance for a bounded, synthetic, undispatched
-- attempt, created with the decision and never after it (W01).
--
-- The transaction contract says: "If the existing model_calls schema cannot
-- express a synthetic undispatched bounded attempt without fabricating
-- model/usage, adapt that existing attempt schema explicitly in L4 ... do not
-- invent a second accounting ledger or falsely name a provider." There is no
-- `model_calls` table in this tree to adapt, so this is that table's first
-- version, written for what this head actually does rather than for a provider
-- call it never makes.
--
-- What that means concretely: `provider` and `model` are nullable and null,
-- `requested` is false, `price_book` names the pinned synthetic estimator, and
-- `estimated_minor` is a real finite number from it. A row here is a record of
-- an attempt that was authorised and reserved. It is not a record of a call.
--
-- **Provenance is immutable; disposition is append-once.** Which version, run,
-- step, reservation and envelope an attempt belongs to, what it was estimated
-- at and when it was created cannot change — those are the facts a later
-- accounting reconciliation reads. `state`, `outcome`, `actual_minor`,
-- `lease_id` and the two markers move forward under the owning transaction's
-- locks, and each settles once.
--
-- **`dispatch_marker` and `observed` exist although nothing sets them.** T5 is
-- explicit that a marked or observed attempt retains its full hold as unknown
-- even when the work is otherwise terminal, and that a later unit owns
-- activation and reconciliation. A classifier written against columns that do
-- not exist is a classifier that silently cannot see the case it was written
-- to refuse, so the columns are here and the classifier reads them.

create table public.attempts (
  business_id     uuid        not null,
  id              uuid        not null,
  reservation_id  uuid        not null,
  envelope_id     uuid        not null,
  version_id      uuid        not null,
  run_id          uuid        not null,
  step_id         uuid        not null,
  lease_id        uuid,
  state           text        not null default 'reserved',
  outcome         text,
  synthetic       boolean     not null default true,
  requested       boolean     not null default false,
  provider        text,
  model           text,
  price_book      text        not null,
  estimated_minor bigint      not null,
  actual_minor    bigint,
  dispatch_marker boolean     not null default false,
  observed        boolean     not null default false,
  created_at      timestamptz not null default now(),
  settled_at      timestamptz,
  constraint attempts_pkey primary key (id),
  constraint attempts_tenant_id_key unique (business_id, id),
  constraint attempts_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint attempts_reservation_fkey foreign key (business_id, reservation_id)
    references public.reservations (business_id, id),
  constraint attempts_envelope_fkey foreign key (business_id, envelope_id)
    references public.task_envelopes (business_id, id),
  constraint attempts_version_fkey foreign key (business_id, version_id)
    references public.proposal_versions (business_id, id),
  constraint attempts_run_fkey foreign key (business_id, run_id)
    references public.planned_runs (business_id, id),
  constraint attempts_step_fkey foreign key (business_id, step_id)
    references public.planned_steps (business_id, id),
  constraint attempts_lease_fkey foreign key (business_id, lease_id)
    references public.leases (business_id, id),
  constraint attempts_state_known
    check (state in ('reserved', 'dispatched', 'handed_back', 'abandoned', 'quarantined')),
  constraint attempts_outcome_known
    check (outcome is null or outcome in ('completed', 'failed', 'abandoned', 'unknown')),
  constraint attempts_estimated_positive check (estimated_minor > 0),
  constraint attempts_actual_not_negative check (actual_minor is null or actual_minor >= 0),
  -- This head serves no provider. A row naming one would be the false
  -- attribution the contract forbids, so the schema refuses it until a later
  -- unit removes this line as part of activating dispatch.
  constraint attempts_synthetic_names_no_provider
    check (not synthetic or (provider is null and model is null and not requested)),
  -- A marker with no dispatch path is a corrupt or imported row, and T5 says
  -- it is quarantined with its hold retained rather than completed.
  constraint attempts_marked_is_quarantined
    check (not (dispatch_marker or observed) or state = 'quarantined')
);

-- One attempt per reservation. "Retry cannot mint a second hold" (T3) and
-- "no duplicate hold" (W01) are the same sentence, and this is it as an index.
create unique index attempts_reservation_idx on public.attempts (business_id, reservation_id);

create index attempts_business_idx on public.attempts (business_id);

create index attempts_lease_idx on public.attempts (business_id, lease_id);

create index attempts_envelope_idx on public.attempts (business_id, envelope_id);

-- Provenance cannot be edited and no row can be deleted. The disposition
-- columns move forward, and the ones that settle do so from null exactly once,
-- so a second settlement is the server's refusal rather than the last writer's
-- value.
create function public.attempts_provenance_is_immutable() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'attempts are immutable: attempt % cannot be deleted', old.id
      using errcode = 'restrict_violation';
  end if;
  if new.id is distinct from old.id
     or new.business_id is distinct from old.business_id
     or new.reservation_id is distinct from old.reservation_id
     or new.envelope_id is distinct from old.envelope_id
     or new.version_id is distinct from old.version_id
     or new.run_id is distinct from old.run_id
     or new.step_id is distinct from old.step_id
     or new.synthetic is distinct from old.synthetic
     or new.price_book is distinct from old.price_book
     or new.estimated_minor is distinct from old.estimated_minor
     or new.created_at is distinct from old.created_at then
    raise exception 'attempts are immutable: attempt % has provenance that cannot be edited', old.id
      using errcode = 'restrict_violation';
  end if;
  if old.actual_minor is not null and new.actual_minor is distinct from old.actual_minor then
    raise exception 'attempt % is already settled at %', old.id, old.actual_minor
      using errcode = 'restrict_violation';
  end if;
  if old.outcome is not null and new.outcome is distinct from old.outcome then
    raise exception 'attempt % already recorded outcome %', old.id, old.outcome
      using errcode = 'restrict_violation';
  end if;
  -- A marker is evidence that something happened outside this head's reachable
  -- operations. It can be raised and it can never be lowered, because lowering
  -- it is how a real liability would be erased.
  if old.dispatch_marker and not new.dispatch_marker then
    raise exception 'attempt % carries a dispatch marker, which cannot be cleared', old.id
      using errcode = 'restrict_violation';
  end if;
  if old.observed and not new.observed then
    raise exception 'attempt % carries an observation, which cannot be cleared', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.attempts_provenance_is_immutable() from public;

create trigger attempts_immutable
  before update or delete on public.attempts
  for each row execute function public.attempts_provenance_is_immutable();

alter table public.attempts enable row level security;
alter table public.attempts force row level security;

create policy tenancy_attempts on public.attempts
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_attempts on public.attempts
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update on public.attempts to ops_astro_app;
