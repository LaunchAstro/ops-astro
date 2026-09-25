-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0001 tenancy. The tenancy root, the session-setting barrier every later
-- table sits behind, and the privileges the application role runs under.
--
-- Three things are established here that every later migration inherits.
--
-- 1. The barrier is a session setting, not the auth provider's own function,
--    so the core runs without GoTrue (ADR 0014). It is set with SET LOCAL
--    inside the serving transaction, because poolers share database roles
--    across connections and a setting that outlives its transaction is handed
--    to the next tenant.
-- 2. Row security is enabled AND forced. Without FORCE the table's owner is
--    exempt, and the owner is who migrations run as.
-- 3. The application role owns nothing and may create nothing. It reaches the
--    tables through grants only, so runtime DDL is refused by privilege
--    rather than by discipline.

-- The migration ledger is not an application table and does not live among
-- them. Everything in `public` is an application table and answers to the
-- tenancy conformance set; `ops` is the installation's own bookkeeping.
create schema ops;
revoke all on schema ops from public;

create table ops.schema_migrations (
  version    text        not null primary key,
  checksum   text        not null,
  applied_at timestamptz not null default now()
);

-- The one function the tenancy policies read. STABLE, security invoker, and
-- not executable by PUBLIC: a definer-rights function readable by everyone is
-- how a barrier stops being one.
--
-- An unset or empty setting yields NULL, and `business_id = NULL` is NULL
-- rather than true, so the default is to see nothing. A setting holding
-- something that is not a uuid raises rather than matching, which is the
-- loud failure the quiet one would hide.
create function public.app_business_id() returns uuid
  language sql
  stable
  as $$ select nullif(current_setting('app.business_id', true), '')::uuid $$;

revoke execute on function public.app_business_id() from public;

-- The tenancy root. `business_id` is the row's own id, so that the rule "every
-- application table carries business_id" has no exception to remember, and so
-- that businesses is a composite-foreign-key parent like every other table.
create table public.businesses (
  business_id uuid        not null,
  id          uuid        not null,
  key         text        not null,
  name        text        not null,
  created_at  timestamptz not null default now(),
  constraint businesses_pkey primary key (id),
  constraint businesses_is_its_own_tenant check (business_id = id),
  constraint businesses_tenant_id_key unique (business_id, id)
);

-- Tenant-scoped uniqueness, never a global one.
create unique index businesses_key_idx on public.businesses (business_id, key);

alter table public.businesses enable row level security;
alter table public.businesses force row level security;

-- The tenancy policy is RESTRICTIVE, so no later permissive policy can widen
-- it. The function call is wrapped as (select ...) so it is evaluated once per
-- statement rather than once per row, and the policy carries no join.
create policy tenancy_businesses on public.businesses
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

-- The permissive baseline. A table with row security enabled and only
-- restrictive policies shows nothing at all, so a permissive policy has to
-- exist for the restrictive one to restrict. This one grants everything and is
-- the placeholder the grant model replaces in T1c; the tenancy barrier does
-- not depend on it, which is the point of the barrier being restrictive.
create policy authority_businesses on public.businesses
  as permissive
  for all
  using (true)
  with check (true);

-- Privileges. The application role is a group role with no login of its own;
-- an installation's login role is a member of it.
grant usage on schema public to ops_astro_app;
grant select, insert, update, delete on public.businesses to ops_astro_app;
grant execute on function public.app_business_id() to ops_astro_app;

-- Nothing outside the grants above, and no create privilege anywhere. This is
-- the default in PostgreSQL 15 and later; it is written down so that an older
-- server, or a restored database that predates the change, does not quietly
-- hand the application role a schema it can build in.
revoke create on schema public from public;
revoke create on schema public from ops_astro_app;
