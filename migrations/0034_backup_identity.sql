-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0034 the backup identity (ticket S0-3, line C1; TR-SEC-8, TR-SECPIR4-3).
--
-- The scheduled backup reads the product's schemas and the auth server's,
-- once, as one consistent snapshot, and does nothing else here but one write.
-- pg_dump reads with row security off and fails on any table a policy would
-- filter, so the role reads past row security; what keeps it to reading is
-- that it is granted select and nothing more. It owns nothing, may not log in,
-- and holds one function privilege: the product revokes execute from PUBLIC on
-- each of its functions, and only `ops.set_restore_challenge` is granted here.
-- TEMPORARY is already revoked from PUBLIC (0031).
--
-- That one write is the restore challenge (S0-3e, REV158K criterion 13).
-- Before each dump the job writes a fresh random value into the one row of
-- `ops.restore_challenge`, so the dump carries it, and gives the backup store
-- only its sha256. A restore drill reads it back from the database it
-- restored, and the store takes a carried drill as passed only with it: a
-- pass needs evidence only a real restore gives. No other role reads the row;
-- the tenancy role never sees it.
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

-- The restore challenge: one row, replaced before each dump. The table is
-- made after the grants above, so the backup identity's select reaches it
-- through the default privileges; nothing else is granted on it.
create table ops.restore_challenge (
  one boolean primary key default true check (one),
  challenge text not null check (challenge ~ '^[0-9a-f]{64}$'),
  written_at timestamptz not null default now()
);
revoke all on ops.restore_challenge from public;
grant select on ops.restore_challenge to ops_astro_backup;

create function ops.set_restore_challenge(challenge text) returns void
  language plpgsql security definer set search_path = pg_catalog as $$
begin
  if $1 is null or $1 !~ '^[0-9a-f]{64}$' then
    raise exception 'a restore challenge is 64 hex characters' using errcode = 'invalid_parameter_value';
  end if;
  insert into ops.restore_challenge (challenge) values ($1)
  on conflict (one) do update set challenge = excluded.challenge, written_at = now();
end $$;
revoke execute on function ops.set_restore_challenge(text) from public;
grant execute on function ops.set_restore_challenge(text) to ops_astro_backup;

comment on role ops_astro_backup is
  'Backup identity. Reads every table in one consistent snapshot, past row security; '
  'writes only the restore challenge, through ops.set_restore_challenge; '
  'no schema change, no other function, no login of its own.';
