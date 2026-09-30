-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0056 custody: the business's secrets, sealed (C31, U33).
--
-- One row per named secret at one scope: the business as a whole, or one
-- client (a `party`, the scope a party-scoped grant names). A row says whether
-- a value is set, who set or cleared it, and when the broker last used it.
-- It never says what the value is to anyone but the broker.
--
-- The value is sealed to the broker's public key before it reaches this
-- table (`packages/core-records/src/custody/sealing.ts`): X25519 with a fresh
-- ephemeral key per value, then AES-256-GCM. The application holds only the
-- public half, so the process that writes a secret cannot open one (ADR 0028:
-- the broker alone holds the credential-store key). Opening is the broker's,
-- AW-01's.
--
-- **The application role cannot select the sealed columns.** The grants at
-- the foot are column grants: `ops_astro_app` may insert and update the row
-- and select everything except `sealed`, `ephemeral_public` and `nonce`. A
-- read that names them is refused by the server, not by a convention in a
-- projection, so no read path added later can leak them by selecting `*`.
--
-- A cleared secret keeps its row with the three sealed columns null: the
-- history of who set and cleared it stays, and the value does not.

create table public.custody_secrets (
  business_id         uuid        not null,
  id                  uuid        not null,
  name                text        not null,
  scope_kind          text        not null,
  scope_id            uuid,
  sealed              bytea,
  ephemeral_public    bytea,
  nonce               bytea,
  key_id              text,
  set_at              timestamptz,
  set_by_actor_id     uuid,
  cleared_at          timestamptz,
  cleared_by_actor_id uuid,
  last_used_at        timestamptz,
  revision            bigint      not null default 1,
  created_at          timestamptz not null default now(),
  constraint custody_secrets_pkey primary key (id),
  constraint custody_secrets_tenant_id_key unique (business_id, id),
  constraint custody_secrets_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint custody_secrets_set_by_fkey foreign key (business_id, set_by_actor_id)
    references public.actors (business_id, id),
  constraint custody_secrets_cleared_by_fkey foreign key (business_id, cleared_by_actor_id)
    references public.actors (business_id, id),
  constraint custody_secrets_name_shape check (name ~ '^[a-z][a-z0-9_.-]{1,99}$'),
  constraint custody_secrets_scope_kind_known check (scope_kind in ('business', 'party')),
  constraint custody_secrets_scope_id_matches check ((scope_kind = 'business') = (scope_id is null)),
  -- Sealed is whole or absent: never a ciphertext without the key that opens it.
  constraint custody_secrets_sealed_is_whole check (
    (sealed is null) = (ephemeral_public is null)
    and (sealed is null) = (nonce is null)
    and (sealed is null) = (key_id is null)
    and (sealed is null) = (set_at is null)),
  constraint custody_secrets_revision_positive check (revision >= 1)
);

-- One row per name at one scope. `nulls not distinct`, so the business-wide
-- row (a null scope id) is one row and not one per insert.
create unique index custody_secrets_name_scope_idx
  on public.custody_secrets (business_id, name, scope_kind, scope_id) nulls not distinct;

alter table public.custody_secrets enable row level security;
alter table public.custody_secrets force row level security;

create policy tenancy_custody_secrets on public.custody_secrets
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_custody_secrets on public.custody_secrets
  as permissive for all using (true) with check (true);

grant select (business_id, id, name, scope_kind, scope_id, key_id, set_at, set_by_actor_id,
              cleared_at, cleared_by_actor_id, last_used_at, revision, created_at)
  on public.custody_secrets to ops_astro_app;
grant insert, update on public.custody_secrets to ops_astro_app;
