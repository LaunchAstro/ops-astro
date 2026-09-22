-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0002 identity. The seven tables that keep login, person, actor and
-- membership as four separate relationships, and the merge record that keeps
-- identity resolution from arbitrating.
--
-- The rule this migration exists to hold is the one the legacy system broke:
-- a login is not a person, a person is not an actor, and membership is not
-- authority. Collapsing them is how a money approval ended up available to
-- anyone who could sign in (minimum contract, section 1.1).
--
-- Four things every table below inherits from 0001 and does not restate.
--
-- 1. `business_id uuid not null`, indexed through the tenant unique key, with
--    row security enabled AND forced.
-- 2. Exactly one RESTRICTIVE policy reading the session setting through
--    `app_business_id()`, wrapped as `(select ...)`, with no join; and one
--    permissive baseline for it to restrict, which T1c's grant model replaces.
-- 3. Every cross-table foreign key is composite and leads with `business_id`
--    on both sides. A table's link to its own business is spelled
--    `(business_id, business_id) references businesses (business_id, id)`,
--    which reads oddly and is exact: `businesses` carries its own id as its
--    `business_id`, so this is the single-column reference the law wants,
--    written in the shape the linter can check without an exception.
-- 4. The application role reaches these tables through grants only. It owns
--    nothing and may create nothing.

-- People. An enduring individual within a business, persisting while logins,
-- roles and relationships change. There is no login column and no active flag:
-- a person is not an account, and whether a person is still the one to write
-- to is a question for `person_merges`, not a boolean somebody has to keep in
-- step with it.
create table public.people (
  business_id  uuid        not null,
  id           uuid        not null,
  display_name text        not null,
  created_at   timestamptz not null default now(),
  constraint people_pkey primary key (id),
  constraint people_tenant_id_key unique (business_id, id),
  constraint people_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint people_display_name_present check (length(btrim(display_name)) > 0)
);

alter table public.people enable row level security;
alter table public.people force row level security;

create policy tenancy_people on public.people
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_people on public.people
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update, delete on public.people to ops_astro_app;

-- Actors. The person or service taking an action under an identified
-- authority, which is not necessarily the owner or assignee of the work.
-- A delegated agent and a worker are actors with no person of their own, which
-- is why this is a separate table rather than a column on `people`.
create table public.actors (
  business_id     uuid        not null,
  id              uuid        not null,
  kind            text        not null,
  person_id       uuid,
  active          boolean     not null default true,
  created_at      timestamptz not null default now(),
  deactivated_at  timestamptz,
  constraint actors_pkey primary key (id),
  constraint actors_tenant_id_key unique (business_id, id),
  constraint actors_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint actors_person_fkey foreign key (business_id, person_id)
    references public.people (business_id, id),
  constraint actors_kind_known check (kind in ('person', 'agent', 'worker')),
  -- An actor of kind person is that person acting; an agent or a worker holds
  -- no person of its own, and its subject lives on the delegation or the lease
  -- that authorises it. Equality rather than an implication, so neither half
  -- can drift.
  constraint actors_person_kind_carries_a_person check ((kind = 'person') = (person_id is not null)),
  -- Deactivation is a fact with a time, not a flag. Every class is a real
  -- actor row that can be deactivated, so the pair must stay consistent.
  constraint actors_active_or_dated check (active = (deactivated_at is null))
);

-- One acting identity per person at a time. A second active person actor is
-- two authorities for one person, which is the collapse this table prevents.
create unique index actors_one_active_person_idx
  on public.actors (business_id, person_id)
  where kind = 'person' and active;

alter table public.actors enable row level security;
alter table public.actors force row level security;

create policy tenancy_actors on public.actors
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_actors on public.actors
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update, delete on public.actors to ops_astro_app;

-- Logins. The product's own row per auth-provider subject, so that the product
-- owns the mapping rather than asking the auth provider what a caller may do.
-- The row confers nothing by existing: a verified login with no active mapping
-- in the named business is refused, not shown an empty result.
create table public.logins (
  business_id uuid        not null,
  id          uuid        not null,
  provider    text        not null,
  subject     text        not null,
  created_at  timestamptz not null default now(),
  constraint logins_pkey primary key (id),
  constraint logins_tenant_id_key unique (business_id, id),
  constraint logins_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint logins_provider_present check (length(btrim(provider)) > 0),
  constraint logins_subject_present check (length(btrim(subject)) > 0)
);

-- Tenant-scoped, never global. The same provider subject in two businesses is
-- two login rows, which is what keeps one business's membership from being
-- readable through another's.
create unique index logins_subject_idx on public.logins (business_id, provider, subject);

alter table public.logins enable row level security;
alter table public.logins force row level security;

create policy tenancy_logins on public.logins
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_logins on public.logins
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update, delete on public.logins to ops_astro_app;

-- Which login currently resolves to which person. Append and deactivate, never
-- delete, so a superseded login cannot silently keep resolving and the trail of
-- who linked what stays readable.
create table public.person_logins (
  business_id        uuid        not null,
  id                 uuid        not null,
  login_id           uuid        not null,
  person_id          uuid        not null,
  active             boolean     not null default true,
  linked_by_actor_id uuid        not null,
  linked_at          timestamptz not null default now(),
  deactivated_at     timestamptz,
  constraint person_logins_pkey primary key (id),
  constraint person_logins_tenant_id_key unique (business_id, id),
  constraint person_logins_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint person_logins_login_fkey foreign key (business_id, login_id)
    references public.logins (business_id, id),
  constraint person_logins_person_fkey foreign key (business_id, person_id)
    references public.people (business_id, id),
  constraint person_logins_linked_by_fkey foreign key (business_id, linked_by_actor_id)
    references public.actors (business_id, id),
  constraint person_logins_active_or_dated check (active = (deactivated_at is null))
);

-- One login resolves to one person. Deactivated rows stay, so the index is
-- partial: history is kept and only the live mapping is unique.
create unique index person_logins_one_active_idx
  on public.person_logins (business_id, login_id)
  where active;

alter table public.person_logins enable row level security;
alter table public.person_logins force row level security;

create policy tenancy_person_logins on public.person_logins
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_person_logins on public.person_logins
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update, delete on public.person_logins to ops_astro_app;

-- A person's standing in a business, with a role key. Membership is what makes
-- a login resolvable at all; it is not authority, which is `grants` in T1c.
create table public.memberships (
  business_id uuid        not null,
  id          uuid        not null,
  person_id   uuid        not null,
  role_key    text        not null,
  active      boolean     not null default true,
  joined_at   timestamptz not null default now(),
  ended_at    timestamptz,
  constraint memberships_pkey primary key (id),
  constraint memberships_tenant_id_key unique (business_id, id),
  constraint memberships_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint memberships_person_fkey foreign key (business_id, person_id)
    references public.people (business_id, id),
  -- A key, not a display word. What the key means is preset configuration and
  -- changes without a migration.
  constraint memberships_role_key_shape check (role_key ~ '^[a-z][a-z0-9_]*$'),
  constraint memberships_active_or_dated check (active = (ended_at is null))
);

create unique index memberships_one_active_idx
  on public.memberships (business_id, person_id)
  where active;

alter table public.memberships enable row level security;
alter table public.memberships force row level security;

create policy tenancy_memberships on public.memberships
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_memberships on public.memberships
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update, delete on public.memberships to ops_astro_app;

-- Observed identifiers for a person: the alias table. Nothing here is a
-- uniqueness constraint on the address alone, which is the whole point — two
-- people can be observed at one address, and that is a question for a human,
-- not a merge the database performs by accident.
create table public.person_identifiers (
  business_id       uuid          not null,
  id                uuid          not null,
  person_id         uuid          not null,
  kind              text          not null,
  -- The normalised form, which is what matching reads.
  value             text          not null,
  -- The form the source actually presented, kept because it is the evidence.
  observed_value    text          not null,
  source_system     text          not null,
  source_id         text,
  first_observed_at timestamptz   not null default now(),
  last_observed_at  timestamptz   not null default now(),
  confidence        numeric(3, 2) not null default 1.00,
  review_state      text          not null default 'observed',
  constraint person_identifiers_pkey primary key (id),
  constraint person_identifiers_tenant_id_key unique (business_id, id),
  constraint person_identifiers_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint person_identifiers_person_fkey foreign key (business_id, person_id)
    references public.people (business_id, id),
  constraint person_identifiers_kind_known check (kind in ('email', 'phone')),
  constraint person_identifiers_value_present check (length(btrim(value)) > 0),
  constraint person_identifiers_source_present check (length(btrim(source_system)) > 0),
  constraint person_identifiers_review_state_known
    check (review_state in ('observed', 'confirmed', 'rejected')),
  constraint person_identifiers_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint person_identifiers_observed_order check (last_observed_at >= first_observed_at)
);

-- One observation of one address on one person, whose last_observed_at moves
-- rather than accumulating rows.
create unique index person_identifiers_person_value_idx
  on public.person_identifiers (business_id, person_id, kind, value);

-- The index matching reads. Deliberately NOT unique: an address matching more
-- than one person is a question, and a unique index would answer it by
-- refusing the second person instead.
create index person_identifiers_value_idx
  on public.person_identifiers (business_id, kind, value);

alter table public.person_identifiers enable row level security;
alter table public.person_identifiers force row level security;

create policy tenancy_person_identifiers on public.person_identifiers
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_person_identifiers on public.person_identifiers
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update, delete on public.person_identifiers to ops_astro_app;

-- A recorded merge decision, and its reversal. A merge is never a side effect
-- of an update and never available to the generic record editor: it names the
-- actor who decided and the evidence they decided on, and a split reverses it
-- without erasing either person's history.
create table public.person_merges (
  business_id          uuid        not null,
  id                   uuid        not null,
  surviving_person_id  uuid        not null,
  absorbed_person_id   uuid        not null,
  decided_by_actor_id  uuid        not null,
  decided_at           timestamptz not null default now(),
  evidence             text        not null,
  reversed_at          timestamptz,
  reversed_by_actor_id uuid,
  reversal_evidence    text,
  constraint person_merges_pkey primary key (id),
  constraint person_merges_tenant_id_key unique (business_id, id),
  constraint person_merges_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint person_merges_surviving_fkey foreign key (business_id, surviving_person_id)
    references public.people (business_id, id),
  constraint person_merges_absorbed_fkey foreign key (business_id, absorbed_person_id)
    references public.people (business_id, id),
  constraint person_merges_decided_by_fkey foreign key (business_id, decided_by_actor_id)
    references public.actors (business_id, id),
  constraint person_merges_reversed_by_fkey foreign key (business_id, reversed_by_actor_id)
    references public.actors (business_id, id),
  constraint person_merges_two_people check (surviving_person_id <> absorbed_person_id),
  constraint person_merges_evidence_present check (length(btrim(evidence)) > 0),
  -- A reversal is a decision like the merge was: all three facts or none.
  constraint person_merges_reversal_complete check (
    (reversed_at is null and reversed_by_actor_id is null and reversal_evidence is null)
    or (reversed_at is not null and reversed_by_actor_id is not null
        and length(btrim(reversal_evidence)) > 0)
  )
);

-- A person is absorbed once at a time. Reversed rows stay as history, so the
-- index is partial. This is also the index the resolver's chain walk reads.
create unique index person_merges_one_absorption_idx
  on public.person_merges (business_id, absorbed_person_id)
  where reversed_at is null;

alter table public.person_merges enable row level security;
alter table public.person_merges force row level security;

create policy tenancy_person_merges on public.person_merges
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_person_merges on public.person_merges
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update, delete on public.person_merges to ops_astro_app;
