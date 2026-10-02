-- SPDX-License-Identifier: AGPL-3.0-only
-- A UTC timestamp ID (docs/local/DATA.md, "What the schema is"): written after
-- batch 3b took 0100-0111 and migrations moved to timestamps.
--
-- 20261002105957 second-factor codes kept only as long as they count (security review).
-- 0072's rows matter only inside the wrong-code lockout window, five codes in
-- fifteen minutes (`FAILED_CODE_WINDOW_MINUTES`,
-- packages/core-commands/src/commands/account-factor-checks.ts), and nothing
-- removed them, so the table grew by every code ever sent. The daily upkeep
-- job (`backup.mjs expire`) now deletes, through
-- `ops.expire_second_factor_codes()`, every row recorded more than 24 hours
-- ago. The horizon is fixed and far past the window, so a late or skipped
-- run, a clock step or a wider window later never removes a row that still
-- counts; a day is what is kept beyond that. The function takes no argument,
-- so no caller can name a shorter horizon, and answers how many rows it
-- deleted for the job's record.
--
-- Who may do what. The job runs it as `ops_astro_upkeep`, a role no one logs
-- in as, which holds execute on that one function and usage on `ops` and
-- nothing else: it cannot read the table, delete from it directly, or reach
-- any other. The job's login holds the role without inheriting it and takes it
-- by name (`set role`, scripts/ops/staging-logins.ts makes the login, as
-- 0045's). The application group still inserts and reads only (0072), and
-- may not run the function; PUBLIC holds nothing on it.

-- The role is the cluster's, shared by every database on it: made with every
-- attribute said out loud, and altered only when a role made earlier differs
-- (as 0045, 0046, 0047 and 0070 do).
do $$ begin
  create role ops_astro_upkeep nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
exception when duplicate_object or unique_violation then null;
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'ops_astro_upkeep' and (rolcanlogin
      or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) then
    alter role ops_astro_upkeep nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end $$;

create function ops.expire_second_factor_codes() returns bigint
  language sql security definer set search_path = pg_catalog as $$
  with gone as (
    delete from ops.second_factor_codes where recorded_at < now() - interval '24 hours'
    returning 1
  )
  select count(*) from gone
$$;
revoke execute on function ops.expire_second_factor_codes() from public;

grant usage on schema ops to ops_astro_upkeep;
grant execute on function ops.expire_second_factor_codes() to ops_astro_upkeep;

comment on role ops_astro_upkeep is
  'Daily upkeep identity. Runs ops.expire_second_factor_codes() alone; '
  'no read, no other write, no login of its own.';
