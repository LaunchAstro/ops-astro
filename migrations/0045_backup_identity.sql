-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0045 the backup identity (ticket S0-3, line C1; TR-SEC-8, TR-SECPIR4-3).
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

-- The installation's operating business (S0-3e; REV158K2, REV158S3 and
-- REV854C criterion 4): the one business whose appointed operator exports the
-- whole archive, runs the drill and records it (scripts/ops/operator.ts,
-- requireOperatingOperator). It is installation state, one row, written once
-- by the database's owner at installation (the restore runbook's install
-- step), never by a request and never from a value the operator's environment
-- sets. The application group may read it, and nothing more, so the gate
-- reads it in the same transaction and on the same database as it checks the
-- grant; the backup identity reads it through the default privileges; no
-- other role is granted anything, and it is never changed or removed.
-- It names a business and belongs to none, so it is installation state, not a
-- business's row: its column is `operating_business`, never `business_id`.
create table ops.operating_business (
  one boolean primary key default true check (one),
  operating_business uuid not null references public.businesses (id),
  written_at timestamptz not null default now()
);
revoke all on ops.operating_business from public;
grant select on ops.operating_business to ops_astro_app;

create function ops.operating_business_fixed() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'the operating business is written once, at installation'
    using errcode = 'insufficient_privilege';
end $$;
revoke execute on function ops.operating_business_fixed() from public;
create trigger operating_business_fixed before update or delete or truncate on ops.operating_business
  for each statement execute function ops.operating_business_fixed();

comment on role ops_astro_backup is
  'Backup identity. Reads every table in one consistent snapshot, past row security; '
  'no write, no schema change, no function, no login of its own.';
