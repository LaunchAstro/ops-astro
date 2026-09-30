-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0058 standing approvals (C52-A, U36; CS-6.10, C27-1 and C27-2).
--
-- A person adopts an exact released version for an activation: the adoption
-- pins it and is the standing approval for every later occurrence on that
-- pin. A rollback is an adoption of the version before, recorded as one. Each
-- adoption is written once, with the activation revision it wrote, and the
-- activation names the one that stands (`approval_id`). A revocation is its
-- own row beside the approval, written once; the approval stays in history.
--
-- The approval stands until somebody edits the automation or turns it off
-- (C27-1): the trigger below clears `approval_id` when the pin, mode,
-- schedule or event changes, or the activation is switched off, unless the
-- same write names a new adoption. A write may name only the adoption that
-- wrote this revision, so no edit can point back at an older approval.
--
-- An occurrence records the approval it saw when it was claimed; dispatch
-- rechecks it under the activation's lock and writes the result once, in
-- `occurrence_dispatches`: a run started, or why not. A run is unique on its
-- dispatch. The run itself is the agent engine's (AW-01, not on this branch).

alter table public.activations
  add column approval_id uuid,
  add constraint activations_of_definition_key unique (business_id, definition_id, id);

create table public.standing_approvals (
  business_id          uuid        not null,
  id                   uuid        not null,
  activation_id        uuid        not null,
  definition_id        uuid        not null,
  version_id           uuid        not null,
  previous_version_id  uuid        not null,
  act                  text        not null,
  sequence             bigint      not null,
  decided_by_actor_id  uuid        not null,
  decided_at           timestamptz not null default now(),
  constraint standing_approvals_pkey primary key (id),
  constraint standing_approvals_tenant_id_key unique (business_id, id),
  constraint standing_approvals_pin_key unique (business_id, activation_id, version_id, id),
  constraint standing_approvals_sequence_once unique (business_id, activation_id, sequence),
  constraint standing_approvals_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint standing_approvals_activation_fkey foreign key (business_id, definition_id, activation_id)
    references public.activations (business_id, definition_id, id),
  constraint standing_approvals_version_fkey foreign key (business_id, definition_id, version_id)
    references public.definition_versions (business_id, definition_id, id),
  constraint standing_approvals_previous_fkey foreign key (business_id, definition_id, previous_version_id)
    references public.definition_versions (business_id, definition_id, id),
  constraint standing_approvals_decider_fkey foreign key (business_id, decided_by_actor_id)
    references public.actors (business_id, id),
  constraint standing_approvals_act_known check (act in ('adopted', 'rolled_back')),
  constraint standing_approvals_sequence_after_first check (sequence >= 2)
);

alter table public.activations
  add constraint activations_approval_fkey foreign key (business_id, id, version_id, approval_id)
    references public.standing_approvals (business_id, activation_id, version_id, id);

create table public.standing_approval_revocations (
  business_id          uuid        not null,
  id                   uuid        not null,
  approval_id          uuid        not null,
  revoked_by_actor_id  uuid        not null,
  revoked_at           timestamptz not null default now(),
  constraint standing_approval_revocations_pkey primary key (id),
  constraint standing_approval_revocations_tenant_id_key unique (business_id, id),
  constraint standing_approval_revocations_once unique (business_id, approval_id),
  constraint standing_approval_revocations_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint standing_approval_revocations_approval_fkey foreign key (business_id, approval_id)
    references public.standing_approvals (business_id, id),
  constraint standing_approval_revocations_revoker_fkey foreign key (business_id, revoked_by_actor_id)
    references public.actors (business_id, id)
);

alter table public.activation_occurrences
  add column approval_id uuid,
  drop constraint activation_occurrences_outcome_known,
  -- An occurrence past a rate (C33, #483 point 4) starts no run and says which.
  add constraint activation_occurrences_outcome_known
    check (outcome in ('started', 'activation_off', 'no_standing_approval', 'approved',
                       'over_activation_rate', 'over_business_rate')),
  add constraint activation_occurrences_approved_names_approval
    check ((outcome = 'approved') = (approval_id is not null)),
  add constraint activation_occurrences_approval_fkey
    foreign key (business_id, activation_id, version_id, approval_id)
    references public.standing_approvals (business_id, activation_id, version_id, id);

create table public.occurrence_dispatches (
  business_id    uuid        not null,
  id             uuid        not null,
  occurrence_id  uuid        not null,
  outcome        text        not null,
  run_id         uuid,
  dispatched_at  timestamptz not null default now(),
  constraint occurrence_dispatches_pkey primary key (id),
  constraint occurrence_dispatches_tenant_id_key unique (business_id, id),
  constraint occurrence_dispatches_once unique (business_id, occurrence_id),
  constraint occurrence_dispatches_run_once unique (business_id, run_id),
  constraint occurrence_dispatches_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint occurrence_dispatches_occurrence_fkey foreign key (business_id, occurrence_id)
    references public.activation_occurrences (business_id, id),
  constraint occurrence_dispatches_outcome_known
    check (outcome in ('started', 'activation_off', 'approval_revoked', 'approval_ended')),
  constraint occurrence_dispatches_started_names_run check ((outcome = 'started') = (run_id is not null))
);

-- Before the row is written, so the cleared pointer is what is stored. Row
-- security has already limited the update to this business's activation.
create function public.activations_approval_stands() returns trigger
  language plpgsql
  as $$
begin
  if new.approval_id is not distinct from old.approval_id then
    if (new.version_id, new.mode, new.every_minutes, new.event_kind)
         is distinct from (old.version_id, old.mode, old.every_minutes, old.event_kind)
       or (old.enabled and not new.enabled) then
      new.approval_id := null;
    end if;
  elsif new.approval_id is not null
        and not exists (select 1 from public.standing_approvals s
                         where s.business_id = new.business_id and s.id = new.approval_id
                           and s.activation_id = new.id and s.sequence = new.revision) then
    raise exception 'activations: approval % did not write revision % of activation %',
      new.approval_id, new.revision, new.id
      using errcode = 'check_violation', constraint = 'activations_approval_stands';
  end if;
  return new;
end;
$$;

revoke execute on function public.activations_approval_stands() from public;

create trigger activations_approval_stands
  before update on public.activations
  for each row
  execute function public.activations_approval_stands();

alter table public.standing_approvals enable row level security;
alter table public.standing_approvals force row level security;
alter table public.standing_approval_revocations enable row level security;
alter table public.standing_approval_revocations force row level security;
alter table public.occurrence_dispatches enable row level security;
alter table public.occurrence_dispatches force row level security;

create policy tenancy_standing_approvals on public.standing_approvals
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_standing_approvals on public.standing_approvals
  as permissive for all using (true) with check (true);
create policy tenancy_standing_approval_revocations on public.standing_approval_revocations
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_standing_approval_revocations on public.standing_approval_revocations
  as permissive for all using (true) with check (true);
create policy tenancy_occurrence_dispatches on public.occurrence_dispatches
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_occurrence_dispatches on public.occurrence_dispatches
  as permissive for all using (true) with check (true);

-- Approvals, revocations and dispatches are written once and never changed.
grant select, insert on public.standing_approvals to ops_astro_app;
grant select, insert on public.standing_approval_revocations to ops_astro_app;
grant select, insert on public.occurrence_dispatches to ops_astro_app;
grant update (approval_id) on public.activations to ops_astro_app;
