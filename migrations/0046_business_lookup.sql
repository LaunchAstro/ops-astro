-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0046 the business lookup identity (ticket S0-6; the Vercel re-plan,
-- section 6; the orchestrator's ruling G2 (a)).
--
-- The one read that precedes tenancy is a business key to its id
-- (`createBusinessResolver`, apps/api/server.ts): `public.businesses` is
-- behind forced row security keyed on the setting the serving transaction has
-- not set yet. The function on Vercel holds no admin login, so it reads the
-- key as this role: past row security, the `id` and `key` columns of
-- `businesses`, and nothing else. A breach of the function's settings then
-- reads which keys exist and their ids, never a business's records, and the
-- application group's grants and the one definer function are unchanged.
--
-- It owns nothing, may not log in, and holds no function privilege. A login
-- is a member of it (the function's lookup login; locally the admin
-- connection), and the resolver takes the role by name in the key's own
-- transaction (`set local role`), which holds behind a transaction pooler.

-- The role is the cluster's, shared by every database on it: made with every
-- attribute said out loud, and altered only when a role made earlier differs
-- (as 0045 does for the backup identity).
do $$ begin
  create role ops_astro_lookup nologin nosuperuser nocreatedb nocreaterole noreplication bypassrls;
exception when duplicate_object or unique_violation then null;
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'ops_astro_lookup' and (rolcanlogin
      or rolsuper or rolcreatedb or rolcreaterole or rolreplication or not rolbypassrls)) then
    alter role ops_astro_lookup nologin nosuperuser nocreatedb nocreaterole noreplication bypassrls;
  end if;
end $$;

grant usage on schema public to ops_astro_lookup;
grant select (id, key) on public.businesses to ops_astro_lookup;

comment on role ops_astro_lookup is
  'Business lookup identity. Reads id and key of public.businesses past row security; '
  'nothing else, no write, no function, no login of its own.';
