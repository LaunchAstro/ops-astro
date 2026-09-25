-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0008 agent authority. The distinct agent login, the purpose delegation it
-- acts under, the immutable record of every authentication attempt, and the
-- restricted worker role that starts with nothing.
--
-- 0002 kept login, person, actor and membership as four separate
-- relationships, and then `login-resolution.ts` resolved `a.kind = 'person'`
-- only. That is the honest thing to have shipped first and it is not the
-- contract: "a person's login, an agent login and a delegation credential are
-- distinct" (transaction contract, delegation). An agent that signs in with a
-- person's credential is the collapse 0002 exists to prevent, arriving one
-- layer up.
--
-- What this migration does not do is give the agent authority. A delegation
-- names a purpose and a delegating person; what it actually permits is
-- computed on every call by intersecting it with that person's live grants
-- (`authority/delegations.ts`). Nothing here caches a permission, and the
-- decision exclusion below is a constraint rather than a convention, so a
-- delegation that permits a decision cannot be written at all.
--
-- Every table inherits 0001's four rules and does not restate them:
-- `business_id not null` through the tenant unique key, row security enabled
-- AND forced, one restrictive tenancy policy plus a permissive baseline, and
-- composite foreign keys leading with `business_id` on both sides.

-- ---------------------------------------------------------------------------
-- The agent's own login.
-- ---------------------------------------------------------------------------

-- `person_logins` maps a login to a person. This maps a login to an actor that
-- has no person, which is what makes the agent path distinct rather than a
-- person path with a flag on it. The two tables are deliberately not one: a
-- single mapping table with two nullable columns is one row away from an agent
-- resolving as the person who authorised it, and that is precisely the
-- borrowing I01 R5 refuses.
create table public.actor_logins (
  business_id        uuid        not null,
  id                 uuid        not null,
  login_id           uuid        not null,
  actor_id           uuid        not null,
  active             boolean     not null default true,
  linked_by_actor_id uuid        not null,
  linked_at          timestamptz not null default now(),
  deactivated_at     timestamptz,
  constraint actor_logins_pkey primary key (id),
  constraint actor_logins_tenant_id_key unique (business_id, id),
  constraint actor_logins_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint actor_logins_login_fkey foreign key (business_id, login_id)
    references public.logins (business_id, id),
  constraint actor_logins_actor_fkey foreign key (business_id, actor_id)
    references public.actors (business_id, id),
  constraint actor_logins_linked_by_fkey foreign key (business_id, linked_by_actor_id)
    references public.actors (business_id, id),
  constraint actor_logins_active_or_dated check (active = (deactivated_at is null))
);

-- One login resolves to one acting identity, live. Deactivated rows stay.
create unique index actor_logins_one_active_idx
  on public.actor_logins (business_id, login_id)
  where active;

-- A login is a person's or an agent's, never both. A login in both tables
-- would make the order in which the resolver reads them the thing that decides
-- who the caller is, and that is a decision no read order should be making.
-- Two triggers rather than one, because neither table can see the other's rows
-- through a check constraint and the rule has to hold whichever is written
-- second.
create function public.login_is_a_person_or_an_agent() returns trigger
  language plpgsql
  as $$
declare
  conflicting text;
begin
  if tg_table_name = 'actor_logins' then
    select 'a person' into conflicting
      from public.person_logins pl
     where pl.business_id = new.business_id and pl.login_id = new.login_id and pl.active
     limit 1;
  else
    select 'an agent' into conflicting
      from public.actor_logins al
     where al.business_id = new.business_id and al.login_id = new.login_id and al.active
     limit 1;
  end if;
  if conflicting is not null and new.active then
    raise exception 'login % is already mapped to %', new.login_id, conflicting
      using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.login_is_a_person_or_an_agent() from public;

create trigger actor_logins_login_is_not_a_person
  before insert or update on public.actor_logins
  for each row execute function public.login_is_a_person_or_an_agent();

create trigger person_logins_login_is_not_an_agent
  before insert or update on public.person_logins
  for each row execute function public.login_is_a_person_or_an_agent();

alter table public.actor_logins enable row level security;
alter table public.actor_logins force row level security;

create policy tenancy_actor_logins on public.actor_logins
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_actor_logins on public.actor_logins
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update on public.actor_logins to ops_astro_app;

-- ---------------------------------------------------------------------------
-- The purpose delegation.
-- ---------------------------------------------------------------------------

-- What a delegation is: a recorded statement that one person authorised one
-- agent actor to act for one purpose, for a while. What it is not: a set of
-- permissions. The permissions are the delegating person's, live, read on
-- every call, so revoking the person's grant narrows the agent on its next
-- call rather than at the next mint.
--
-- `minted_by_actor_id` names the authorising person's acting identity, which
-- is not the requesting agent. The audit names the agent separately. An agent
-- cannot choose the person or widen the purpose, because neither value comes
-- from the agent's request: `delegate_person_id` is read from the work
-- authorisation the person recorded, and the collections below are checked
-- against that person's grants on use.
create table public.delegations (
  business_id         uuid        not null,
  id                  uuid        not null,
  -- The agent acting. `actors_person_kind_carries_a_person` already refuses a
  -- person actor here through the check below.
  agent_actor_id      uuid        not null,
  -- The person whose live grants are the ceiling. Every call intersects with
  -- them; none of them is copied here.
  delegate_person_id  uuid        not null,
  -- The acting identity of the person who authorised it, per the transaction
  -- contract. Ordinarily the delegating person's own actor; always a person.
  minted_by_actor_id  uuid        not null,
  -- The purpose, as a short stable key, not a sentence. The refusal names it.
  purpose             text        not null,
  -- The collections the purpose reaches. A call outside them is refused on its
  -- own ground before any grant is read.
  collections         text[]      not null,
  -- The actions the purpose permits, and the reason this column exists rather
  -- than "everything the person can do": a delegation is narrower than its
  -- person by construction.
  actions             text[]      not null,
  -- Stored by hash. The credential itself is returned once, to the authorised
  -- caller, and never read back from here.
  credential_hash     text        not null,
  granted_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  revoked_at          timestamptz,
  settled_at          timestamptz,
  constraint delegations_pkey primary key (id),
  constraint delegations_tenant_id_key unique (business_id, id),
  constraint delegations_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint delegations_agent_fkey foreign key (business_id, agent_actor_id)
    references public.actors (business_id, id),
  constraint delegations_person_fkey foreign key (business_id, delegate_person_id)
    references public.people (business_id, id),
  constraint delegations_minted_by_fkey foreign key (business_id, minted_by_actor_id)
    references public.actors (business_id, id),
  constraint delegations_purpose_shape check (purpose ~ '^[a-z][a-z0-9_]{0,62}$'),
  constraint delegations_collections_present check (cardinality(collections) > 0),
  constraint delegations_actions_present check (cardinality(actions) > 0),
  constraint delegations_credential_hash_shape check (credential_hash ~ '^[0-9a-f]{64}$'),
  -- A delegation expires. There is no unbounded one, because an agent
  -- authority nobody has to renew is an agent authority nobody reviews.
  constraint delegations_expiry_after_grant check (expires_at > granted_at),
  constraint delegations_revoked_after_grant check (revoked_at is null or revoked_at >= granted_at),
  -- I07, in the schema. `decide` is excluded from delegation, so there is no
  -- row a later code path could read as permitting one. A person decides.
  constraint delegations_never_decide check (not ('decide' = any (actions))),
  -- Only actions the grant model knows.
  constraint delegations_actions_known check (
    actions <@ array['read', 'comment', 'write', 'assign', 'share', 'manage']::text[]
  )
);

-- An agent actor never holds two live delegations for one purpose; a retry
-- that minted a second one would be a second authority for one authorisation.
create unique index delegations_one_live_per_purpose_idx
  on public.delegations (business_id, agent_actor_id, purpose)
  where revoked_at is null and settled_at is null;

create index delegations_person_idx
  on public.delegations (business_id, delegate_person_id)
  where revoked_at is null and settled_at is null;

alter table public.delegations enable row level security;
alter table public.delegations force row level security;

create policy tenancy_delegations on public.delegations
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_delegations on public.delegations
  as permissive
  for all
  using (true)
  with check (true);

-- No DELETE. Revocation and settlement write a timestamp, as grants do.
grant select, insert, update on public.delegations to ops_astro_app;

-- The agent is an agent. A person actor delegated to would be a person acting
-- through a credential that expires, which is a different mechanism wearing
-- this one's name. Enforced by a trigger because a check constraint cannot
-- read another table.
create function public.delegations_agent_is_an_agent() returns trigger
  language plpgsql
  as $$
begin
  if not exists (
    select 1 from public.actors a
     where a.business_id = new.business_id and a.id = new.agent_actor_id and a.kind = 'agent'
  ) then
    raise exception 'delegations: agent_actor_id % is not an actor of kind agent', new.agent_actor_id
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.actors a
     where a.business_id = new.business_id and a.id = new.minted_by_actor_id
       and a.kind = 'person'
  ) then
    raise exception 'delegations: minted_by_actor_id % is not a person actor', new.minted_by_actor_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.delegations_agent_is_an_agent() from public;

create trigger delegations_agent_is_an_agent
  before insert or update on public.delegations
  for each row execute function public.delegations_agent_is_an_agent();

-- ---------------------------------------------------------------------------
-- Every authentication attempt.
-- ---------------------------------------------------------------------------

-- I13's separate authentication-attempt owner. The domain audit records what a
-- command did; this records who got through the door and who did not, which is
-- a different question with a different retention answer and a different
-- reader.
--
-- The presented subject is stored as a digest and never raw. A refused attempt
-- carries a subject this business has no relationship with — storing it
-- whole would make this table a place to park an identifier in a tenant that
-- never agreed to hold it. On success the verified subject is the login and
-- actor rows, which are this business's own.
create table public.authentication_attempts (
  business_id    uuid        not null,
  id             uuid        not null,
  at             timestamptz not null default now(),
  -- Which path attempted it: the person login, the agent login, or a
  -- delegation credential presented on a call.
  owner          text        not null,
  provider       text        not null,
  subject_digest text        not null,
  outcome        text        not null,
  -- The verified subject, on success only, as this business's own rows.
  login_id       uuid,
  actor_id       uuid,
  person_id      uuid,
  -- The refusal reason, on refusal only. The code, never a sentence.
  refusal_code   text,
  constraint authentication_attempts_pkey primary key (id),
  constraint authentication_attempts_tenant_id_key unique (business_id, id),
  constraint authentication_attempts_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint authentication_attempts_login_fkey foreign key (business_id, login_id)
    references public.logins (business_id, id),
  constraint authentication_attempts_actor_fkey foreign key (business_id, actor_id)
    references public.actors (business_id, id),
  constraint authentication_attempts_person_fkey foreign key (business_id, person_id)
    references public.people (business_id, id),
  constraint authentication_attempts_owner_known
    check (owner in ('person_login', 'agent_login', 'delegation')),
  constraint authentication_attempts_outcome_known check (outcome in ('resolved', 'refused')),
  constraint authentication_attempts_provider_present check (length(btrim(provider)) > 0),
  constraint authentication_attempts_digest_shape check (subject_digest ~ '^[0-9a-f]{64}$'),
  -- Success names the subject and no reason; refusal names the reason and no
  -- subject. Equality rather than two implications, so neither half drifts.
  constraint authentication_attempts_resolved_names_the_subject check (
    (outcome = 'resolved') = (login_id is not null and actor_id is not null)
  ),
  constraint authentication_attempts_refused_names_the_reason check (
    (outcome = 'refused') = (refusal_code is not null)
  ),
  constraint authentication_attempts_refusal_code_shape
    check (refusal_code is null or refusal_code ~ '^[A-Z][A-Z0-9_]*$')
);

create index authentication_attempts_at_idx
  on public.authentication_attempts (business_id, at desc);

create index authentication_attempts_subject_idx
  on public.authentication_attempts (business_id, provider, subject_digest, at desc);

alter table public.authentication_attempts enable row level security;
alter table public.authentication_attempts force row level security;

create policy tenancy_authentication_attempts on public.authentication_attempts
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_authentication_attempts on public.authentication_attempts
  as permissive
  for all
  using (true)
  with check (true);

-- Append only. The runtime may write an attempt and read attempts back; it may
-- not amend one, which is what makes the trail evidence rather than a log.
grant select, insert on public.authentication_attempts to ops_astro_app;

-- ---------------------------------------------------------------------------
-- The restricted worker role.
-- ---------------------------------------------------------------------------

-- I01 R6: a restricted role that exists at the database level and starts with
-- nothing. It is created here rather than by a setup script so that the
-- default-deny is a property of the schema a conformance test can read, not of
-- a shell file somebody ran once.
--
-- It holds no table, sequence or function privilege, and no membership of the
-- application role. A worker connecting as a member of it and selecting from
-- any table is refused by the server, which is the only form of "restricted"
-- that survives a mistake in application code.
--
-- One thing it does hold, and cannot be made not to: USAGE on schema `public`,
-- which Postgres grants to PUBLIC and which no revoke can take from a single
-- role. That is reaching the schema, not reaching anything in it, and the
-- table privileges above are what make the difference. Said here rather than
-- left for a reader to discover in the catalogue and wonder about.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'ops_astro_worker') then
    create role ops_astro_worker nologin nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;

-- Said out loud, because a privilege nobody granted and a privilege somebody
-- revoked read the same in the catalogue and only one of them was decided.
revoke all on schema public from ops_astro_worker;
revoke all on schema ops from ops_astro_worker;
revoke all on all tables in schema public from ops_astro_worker;
revoke all on all tables in schema ops from ops_astro_worker;
revoke all on all functions in schema public from ops_astro_worker;

comment on role ops_astro_worker is
  'Restricted worker identity. Default deny: no schema, table or function privilege. '
  'Work reaches the database through an authorised delegation and the application role, '
  'never through a privilege held by the worker itself.';
