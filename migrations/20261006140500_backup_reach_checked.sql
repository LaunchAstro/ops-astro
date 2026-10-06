-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The backup identity's reach, checked (#999; ticket S0-3, line C1).
--
-- 0045 grants the backup identity its reads, but Postgres only warns when a
-- grant gives nothing, so a grant the migrating owner may not make passed
-- quietly and the first staging backup failed at its dump. Two gaps:
--
-- * Staging's made-up guard (`ops_astro_made_up`, scripts/ops/made-up-install.ts)
--   is made before the migrations run, so 0045's default privileges never
--   reached it. Its owner grants it here; every reset migrates again after it.
-- * On hosted Supabase the auth server's `auth` schema is the platform's
--   (owned by `supabase_admin`, our owner holding USAGE without grant option).
--   It is never granted to the backup identity by any platform role: each
--   would give a read-only identity far more than reads. The hosted dump leaves
--   `auth` out (scripts/ops/backup-dump.mjs); its sign-ins stay in Supabase's
--   own project backup, and staging's made-up cast gets them back from the
--   reset's sign-in step (scripts/ops/staging-reset.mjs).
--
-- Then every schema the dump names that is ours to grant on, and every table
-- and sequence in it, must be readable by the backup identity, or the
-- migration stops and names what is not.

do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'ops_astro_made_up') then
    grant usage on schema ops_astro_made_up to ops_astro_backup;
    grant select on all tables in schema ops_astro_made_up to ops_astro_backup;
    grant select on all sequences in schema ops_astro_made_up to ops_astro_backup;
  end if;
end $$;

do $$
declare
  unread text;
begin
  with dumped as (
    select n.oid, n.nspname from pg_namespace n
     where n.nspname in ('public', 'ops', 'ops_astro_made_up', 'auth')
       -- A schema whose owner's privileges we do not hold is not ours to grant on.
       and pg_has_role(current_user, n.nspowner, 'USAGE')
  )
  select string_agg(missing, ', ' order by missing) into unread from (
    select format('schema %I', d.nspname) as missing from dumped d
     where not has_schema_privilege('ops_astro_backup', d.oid, 'USAGE')
    union all
    select format('%I.%I', d.nspname, c.relname) from dumped d
      join pg_class c on c.relnamespace = d.oid
     where c.relkind in ('r', 'p', 'S')
       and not has_table_privilege('ops_astro_backup', c.oid, 'SELECT')
  ) gaps;
  if unread is not null then
    raise exception 'the backup identity cannot read %', unread
      using errcode = 'insufficient_privilege';
  end if;
end $$;
