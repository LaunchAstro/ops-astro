-- SPDX-License-Identifier: AGPL-3.0-only
-- A UTC timestamp ID (docs/local/DATA.md, "What the schema is").
--
-- 20261005063514 the admin login may take the two identities it acts as.
-- Two places take a role by name on the admin login (DATABASE_ADMIN_URL):
-- the business resolver behind the operator gate (apps/api/server.ts,
-- `set local role ops_astro_lookup`) and the restore drill's stamp
-- (scripts/ops/tested-restore.ts, `set local role ops_astro_restore_drill`).
-- Locally that login is a superuser and may take any role. On hosted
-- Supabase it is not: a role it made is granted back to it with ADMIN OPTION
-- alone (Postgres 16 on, `createrole_self_grant` unset), so both are refused
-- 42501 and the gate refuses every operator.
--
-- So the migrating login grants each of the two to itself with SET and
-- without INHERIT: it may take the role by name and holds none of its
-- privileges otherwise. Only where it holds ADMIN OPTION directly and may not
-- yet take the role, so a superuser, a login without ADMIN OPTION and a
-- second run change nothing. No other role and no other login is granted
-- (tests/db/admin-login-takes-identity-roles.test.ts). Catalogue names are
-- qualified, so no schema on the migrator's search path can stand in for them.

do $$
declare
  identity text;
begin
  foreach identity in array array['ops_astro_lookup', 'ops_astro_restore_drill'] loop
    if exists (select from pg_catalog.pg_auth_members
                where roleid = identity::pg_catalog.regrole
                  and member = (select oid from pg_catalog.pg_roles where rolname = current_user)
                  and admin_option)
       and not pg_catalog.pg_has_role(current_user, identity, 'SET') then
      execute pg_catalog.format('grant %I to %I with inherit false, set true', identity, current_user);
    end if;
  end loop;
end $$;
