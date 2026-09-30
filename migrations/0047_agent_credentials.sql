-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0047 API-2: the agent credential, a standing delegation from the person who
-- issues it to a fresh agent actor of theirs (`authority/agent-credentials.ts`).
--
-- A person issues one on their own account (`credential.issue`, under
-- `credential:write`) for the ticked keys, each held by them at business scope
-- when it is issued, never decide, share or manage, and for at most 90 days.
-- The secret is derived under the delegation credential key in its own domain,
-- shown once in the issue answer, and kept here only as its SHA-256. The issuer
-- or a holder of `access:manage` revokes it (`credential.revoke`), once.
--
-- The guard below keeps the row as issued: only the revocation is ever set,
-- once, and nothing deletes. Using the credential on the agent route leans on
-- S0-6's bearer scheme and is not served yet.

create table public.agent_credentials (
  business_id          uuid        not null,
  id                   uuid        not null,
  agent_actor_id       uuid        not null,
  issued_by_person_id  uuid        not null,
  issued_by_actor_id   uuid        not null,
  purpose              text        not null,
  -- `collection:action` keys, the ticked scope.
  scope                text[]      not null,
  credential_hash      text        not null,
  credential_scheme    text        not null,
  credential_key_id    text        not null,
  issued_at            timestamptz not null default now(),
  expires_at           timestamptz not null,
  revoked_at           timestamptz,
  revoked_by_actor_id  uuid,

  constraint agent_credentials_pkey primary key (id),
  constraint agent_credentials_tenant_id_key unique (business_id, id),
  constraint agent_credentials_one_agent unique (business_id, agent_actor_id),
  constraint agent_credentials_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint agent_credentials_agent_fkey foreign key (business_id, agent_actor_id)
    references public.actors (business_id, id),
  constraint agent_credentials_person_fkey foreign key (business_id, issued_by_person_id)
    references public.people (business_id, id),
  constraint agent_credentials_issuer_fkey foreign key (business_id, issued_by_actor_id)
    references public.actors (business_id, id),
  constraint agent_credentials_revoker_fkey foreign key (business_id, revoked_by_actor_id)
    references public.actors (business_id, id),
  constraint agent_credentials_purpose_present check (length(btrim(purpose)) between 1 and 200),
  -- Never decide, share or manage, whatever the issuer holds.
  constraint agent_credentials_scope_shape check (
    cardinality(scope) between 1 and 32
    and array_to_string(scope, ',')
      ~ '^[a-z][a-z_]{0,39}:(read|comment|write|assign)(,[a-z][a-z_]{0,39}:(read|comment|write|assign))*$'
  ),
  constraint agent_credentials_hash_shape check (credential_hash ~ '^[0-9a-f]{64}$'),
  constraint agent_credentials_scheme_known check (credential_scheme = 'hmac-sha256-v1'),
  constraint agent_credentials_expires_after_issue check (expires_at > issued_at),
  constraint agent_credentials_revocation_whole
    check ((revoked_at is null) = (revoked_by_actor_id is null))
);

create index agent_credentials_issuer
  on public.agent_credentials (business_id, issued_by_person_id);

create function public.agent_credentials_written_once() returns trigger
  language plpgsql
  as $$
  begin
    if (new.business_id, new.id, new.agent_actor_id, new.issued_by_person_id,
        new.issued_by_actor_id, new.purpose, new.scope, new.credential_hash,
        new.credential_scheme, new.credential_key_id, new.issued_at, new.expires_at)
       is distinct from
       (old.business_id, old.id, old.agent_actor_id, old.issued_by_person_id,
        old.issued_by_actor_id, old.purpose, old.scope, old.credential_hash,
        old.credential_scheme, old.credential_key_id, old.issued_at, old.expires_at)
       or (old.revoked_at is not null
           and (new.revoked_at, new.revoked_by_actor_id)
               is distinct from (old.revoked_at, old.revoked_by_actor_id)) then
      raise exception 'IMMUTABLE_FIELD: an agent credential is written once'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end;
  $$;

revoke execute on function public.agent_credentials_written_once() from public;

create trigger agent_credentials_written_once
  before update on public.agent_credentials
  for each row execute function public.agent_credentials_written_once();

alter table public.agent_credentials enable row level security;
alter table public.agent_credentials force row level security;

create policy tenancy_agent_credentials on public.agent_credentials
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_agent_credentials on public.agent_credentials
  as permissive
  for all
  using (true)
  with check (true);

-- Issued, then revoked by update; never deleted.
grant select, insert, update on public.agent_credentials to ops_astro_app;
