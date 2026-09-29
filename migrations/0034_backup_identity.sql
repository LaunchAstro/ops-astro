-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0034 the backup identity (ticket S0-3, line C1; TR-SEC-8, TR-SECPIR4-3).
--
-- The scheduled backup reads the product's schemas and the auth server's,
-- once, as one consistent snapshot, and does nothing else here. pg_dump reads
-- with row security off and fails on any table a policy would filter, so the
-- role reads past row security; what keeps it to reading is that it is granted select and nothing
-- more. It owns nothing, may not log in, and holds no function privilege: the
-- product revokes execute from PUBLIC on each of its functions, and nothing is
-- granted here. TEMPORARY is already revoked from PUBLIC (0031).
--
-- A login is a member of it, made on the machine from the staging runbook,
-- and dumps with `pg_dump --role=ops_astro_backup`. Role attributes are not
-- inherited, which is why the login takes the role by name rather than
-- through membership alone.
--
-- Its other half, write-only on the backup store, is the store's own
-- definition (`deploy/staging/backup-store.sql`).

-- The role is the cluster's, shared by every database on it, so two databases
-- migrating at once must not both write it: it is made with every attribute
-- said out loud, and altered only when a role made earlier by hand differs.
do $$ begin
  create role ops_astro_backup nologin nosuperuser nocreatedb nocreaterole noreplication bypassrls;
exception when duplicate_object or unique_violation then null;
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'ops_astro_backup' and (rolcanlogin
      or rolsuper or rolcreatedb or rolcreaterole or rolreplication or not rolbypassrls)) then
    alter role ops_astro_backup nologin nosuperuser nocreatedb nocreaterole noreplication bypassrls;
  end if;
end $$;

revoke all on schema public from ops_astro_backup;
revoke all on schema ops from ops_astro_backup;
revoke all on all tables in schema public from ops_astro_backup;
revoke all on all tables in schema ops from ops_astro_backup;
revoke all on all sequences in schema public from ops_astro_backup;
revoke all on all sequences in schema ops from ops_astro_backup;
revoke all on all functions in schema public from ops_astro_backup;
revoke all on all functions in schema ops from ops_astro_backup;

grant usage on schema public, ops to ops_astro_backup;
grant select on all tables in schema public, ops to ops_astro_backup;
grant select on all sequences in schema public, ops to ops_astro_backup;

-- What is made later is read too, and only read: a later migration's tables,
-- and the auth server's `auth` schema, which the auth server makes itself on
-- first start as the same owner that runs these migrations
-- (scripts/local/auth-up.sh:147; staging's runbook does the same). Default
-- privileges belong to that owner and reach every schema it makes in this
-- database. An `auth` schema made before this migration is granted here.
alter default privileges grant usage on schemas to ops_astro_backup;
alter default privileges grant select on tables to ops_astro_backup;
alter default privileges grant select on sequences to ops_astro_backup;

do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'auth') then
    grant usage on schema auth to ops_astro_backup;
    grant select on all tables in schema auth to ops_astro_backup;
    grant select on all sequences in schema auth to ops_astro_backup;
  end if;
end $$;

comment on role ops_astro_backup is
  'Backup identity. Reads every table in one consistent snapshot, past row security; '
  'no write, no schema change, no function, no login of its own.';
