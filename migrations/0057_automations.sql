-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0052 automations: definitions, released versions, activations and their
-- occurrences (C33, U36; roadmap#27's model, TR-API2-1).
--
-- `automation_definitions` is one skill or automation a business keeps.
-- `definition_versions` is one release of it: its bytes pinned by digest and
-- size, the inputs and operations it declares, and the activation modes it
-- permits. A person releases a version and nothing else creates one; once
-- written it never changes and is never removed, whoever asks (the trigger
-- below refuses the owner too).
--
-- `activations` runs one definition in one mode (manual, scheduled or event),
-- always pinned to one of that definition's versions, and is changed only by a
-- permissioned person. A mode the pinned version does not permit is refused
-- here as well as by the command. Switching a mode or turning an activation on
-- starts nothing: only an occurrence can, and only once C52-A's standing
-- approval exists for that exact version.
--
-- `activation_occurrences` is each due schedule time or matching event,
-- written once. It is unique on the activation and its due time, or on the
-- activation and the event's id, so a replayed event, a restarted scheduler or
-- two schedulers racing commit one occurrence; and a run is unique on its
-- occurrence, so they start at most one run. Each occurrence records whether
-- its run started or why it did not. The run itself, its pin to the version
-- (AW-02's definition reference slot) and the limits on firing are the agent
-- engine's (AW-01, AW-02; not on this branch).

create table public.automation_definitions (
  business_id          uuid        not null,
  id                   uuid        not null,
  kind                 text        not null,
  name                 text        not null,
  created_by_actor_id  uuid        not null,
  created_at           timestamptz not null default now(),
  constraint automation_definitions_pkey primary key (id),
  constraint automation_definitions_tenant_id_key unique (business_id, id),
  constraint automation_definitions_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint automation_definitions_creator_fkey foreign key (business_id, created_by_actor_id)
    references public.actors (business_id, id),
  constraint automation_definitions_kind_known check (kind in ('skill', 'automation')),
  constraint automation_definitions_name_length check (char_length(name) between 1 and 200)
);

create table public.definition_versions (
  business_id           uuid        not null,
  id                    uuid        not null,
  definition_id         uuid        not null,
  number                integer     not null,
  content_digest        text        not null,
  content_size          bigint      not null,
  inputs                jsonb       not null,
  operations            jsonb       not null,
  modes                 text[]      not null,
  released_by_actor_id  uuid        not null,
  released_at           timestamptz not null default now(),
  constraint definition_versions_pkey primary key (id),
  constraint definition_versions_tenant_id_key unique (business_id, id),
  constraint definition_versions_of_definition_key unique (business_id, definition_id, id),
  constraint definition_versions_number_once unique (business_id, definition_id, number),
  constraint definition_versions_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint definition_versions_definition_fkey foreign key (business_id, definition_id)
    references public.automation_definitions (business_id, id),
  constraint definition_versions_releaser_fkey foreign key (business_id, released_by_actor_id)
    references public.actors (business_id, id),
  constraint definition_versions_number_positive check (number >= 1),
  constraint definition_versions_digest_shape check (content_digest ~ '^[0-9a-f]{64}$'),
  constraint definition_versions_size_known check (content_size >= 0),
  constraint definition_versions_inputs_listed check (jsonb_typeof(inputs) = 'array'),
  constraint definition_versions_operations_listed check (jsonb_typeof(operations) = 'array'),
  constraint definition_versions_modes_known check (
    cardinality(modes) between 1 and 3
    and modes <@ array['manual', 'scheduled', 'event']::text[]
  )
);

create function public.definition_versions_immutable() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'definition_versions: version % in business % is released and never changes',
    old.id, old.business_id
    using errcode = 'check_violation', constraint = 'definition_versions_immutable';
end;
$$;

revoke execute on function public.definition_versions_immutable() from public;

create trigger definition_versions_immutable
  before update or delete on public.definition_versions
  for each row
  execute function public.definition_versions_immutable();

create table public.activations (
  business_id          uuid        not null,
  id                   uuid        not null,
  definition_id        uuid        not null,
  version_id           uuid        not null,
  mode                 text        not null,
  every_minutes        integer,
  event_kind           text,
  enabled              boolean     not null default false,
  changed_by_actor_id  uuid        not null,
  changed_at           timestamptz not null default now(),
  revision             bigint      not null default 1,
  constraint activations_pkey primary key (id),
  constraint activations_tenant_id_key unique (business_id, id),
  constraint activations_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint activations_version_fkey foreign key (business_id, definition_id, version_id)
    references public.definition_versions (business_id, definition_id, id),
  constraint activations_changer_fkey foreign key (business_id, changed_by_actor_id)
    references public.actors (business_id, id),
  constraint activations_mode_known check (mode in ('manual', 'scheduled', 'event')),
  constraint activations_schedule_shape check (
    (mode = 'scheduled') = (every_minutes is not null)
    and (every_minutes is null or every_minutes between 1 and 10080)
  ),
  constraint activations_event_shape check (
    (mode = 'event') = (event_kind is not null)
    and (event_kind is null or event_kind ~ '^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){1,3}$')
  ),
  constraint activations_revision_positive check (revision >= 1)
);

-- An after trigger, so row security has refused another business's row first
-- and only a row this business may write is asked about its mode. The write
-- passed row security on `activations`, so its pinned version is visible here.
create function public.activations_mode_permitted() returns trigger
  language plpgsql
  as $$
begin
  if not exists (select 1 from public.definition_versions v
                  where v.business_id = new.business_id and v.id = new.version_id
                    and new.mode = any (v.modes)) then
    raise exception 'activations: version % does not permit mode %', new.version_id, new.mode
      using errcode = 'check_violation', constraint = 'activations_mode_permitted';
  end if;
  return null;
end;
$$;

revoke execute on function public.activations_mode_permitted() from public;

create constraint trigger activations_mode_permitted
  after insert or update of mode, version_id on public.activations
  for each row
  execute function public.activations_mode_permitted();

create table public.activation_occurrences (
  business_id    uuid        not null,
  id             uuid        not null,
  activation_id  uuid        not null,
  version_id     uuid        not null,
  due_at         timestamptz,
  event_id       text,
  outcome        text        not null,
  run_id         uuid,
  recorded_at    timestamptz not null default now(),
  constraint activation_occurrences_pkey primary key (id),
  constraint activation_occurrences_tenant_id_key unique (business_id, id),
  constraint activation_occurrences_due_once unique (business_id, activation_id, due_at),
  constraint activation_occurrences_event_once unique (business_id, activation_id, event_id),
  constraint activation_occurrences_run_once unique (business_id, run_id),
  constraint activation_occurrences_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint activation_occurrences_activation_fkey foreign key (business_id, activation_id)
    references public.activations (business_id, id),
  constraint activation_occurrences_version_fkey foreign key (business_id, version_id)
    references public.definition_versions (business_id, id),
  constraint activation_occurrences_one_cause check ((due_at is null) <> (event_id is null)),
  constraint activation_occurrences_event_shape
    check (event_id is null or event_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  constraint activation_occurrences_outcome_known
    check (outcome in ('started', 'activation_off', 'no_standing_approval')),
  constraint activation_occurrences_started_names_run check ((outcome = 'started') = (run_id is not null))
);

alter table public.automation_definitions enable row level security;
alter table public.automation_definitions force row level security;
alter table public.definition_versions enable row level security;
alter table public.definition_versions force row level security;
alter table public.activations enable row level security;
alter table public.activations force row level security;
alter table public.activation_occurrences enable row level security;
alter table public.activation_occurrences force row level security;

create policy tenancy_automation_definitions on public.automation_definitions
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_automation_definitions on public.automation_definitions
  as permissive for all using (true) with check (true);
create policy tenancy_definition_versions on public.definition_versions
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_definition_versions on public.definition_versions
  as permissive for all using (true) with check (true);
create policy tenancy_activations on public.activations
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_activations on public.activations
  as permissive for all using (true) with check (true);
create policy tenancy_activation_occurrences on public.activation_occurrences
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_activation_occurrences on public.activation_occurrences
  as permissive for all using (true) with check (true);

-- Definitions, versions and occurrences are written once and never changed.
-- An activation's mode, schedule, event, pin and switch change, each by a
-- person, and its revision serialises two changes.
grant select, insert on public.automation_definitions to ops_astro_app;
grant select, insert on public.definition_versions to ops_astro_app;
grant select, insert,
  update (version_id, mode, every_minutes, event_kind, enabled, changed_by_actor_id, changed_at, revision)
  on public.activations to ops_astro_app;
grant select, insert on public.activation_occurrences to ops_astro_app;
