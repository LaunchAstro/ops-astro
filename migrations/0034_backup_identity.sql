-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0034 the backup identity (ticket S0-3, line C1; TR-SEC-8, TR-SECPIR4-3).
--
-- The scheduled backup reads the whole database once, as one consistent
-- snapshot, and does nothing else here. pg_dump reads with row security off
-- and fails on any table a policy would filter, so the role reads past row
-- security; what keeps it to reading is that it is granted select and nothing
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

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'ops_astro_backup') then
    create role ops_astro_backup nologin;
  end if;
end $$;

-- Every attribute said out loud, so a role made earlier by hand is brought to
-- the same place.
alter role ops_astro_backup nologin nosuperuser nocreatedb nocreaterole noreplication bypassrls;

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

-- Tables a later migration adds are read too, and only read. Default
-- privileges belong to the role that runs the migrations, which is the role
-- that creates every table.
alter default privileges in schema public, ops grant select on tables to ops_astro_backup;
alter default privileges in schema public, ops grant select on sequences to ops_astro_backup;

comment on role ops_astro_backup is
  'Backup identity. Reads every table in one consistent snapshot, past row security; '
  'no write, no schema change, no function, no login of its own.';
