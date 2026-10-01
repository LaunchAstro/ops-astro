-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0068 the date of the last tested restore (ticket C55, carried from S0-3,
-- TR-S-B1-5; ORCH47's ruling (b)7).
--
-- The drill's receipt lives in the backup store (`backups.drills`,
-- deploy/staging/backup-store.sql), a server the API has no route to. So a
-- drill the store took as passed also stamps one row here, and the operations
-- view reads it (`operations.read`). The row is installation state: the time
-- alone, with no business, person, path, key or record content, like
-- `ops.operating_business` (0045).
--
-- Who may do what. The application group selects it and nothing more. The
-- drill writes it only through `ops.record_tested_restore()`, as
-- `ops_astro_restore_drill`, a role no one logs in as, which holds execute on
-- that one function and usage on `ops` and nothing else: it cannot read the
-- row, any other table, or name a date. The function takes no argument and
-- stamps the database's own time, never moving it back, so the most a misuse
-- can do is say a restore passed just now. The drill takes the role by name
-- on the owner's connection (`set local role`, scripts/ops/operator.ts), as
-- the business lookup takes 0046's. PUBLIC holds nothing on either.

create table ops.last_tested_restore (
  one boolean primary key default true check (one),
  at timestamptz not null
);
revoke all on ops.last_tested_restore from public;
grant select on ops.last_tested_restore to ops_astro_app;

-- The role is the cluster's, shared by every database on it: made with every
-- attribute said out loud, and altered only when a role made earlier differs
-- (as 0045, 0046 and 0047 do).
do $$ begin
  create role ops_astro_restore_drill nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
exception when duplicate_object or unique_violation then null;
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'ops_astro_restore_drill' and (rolcanlogin
      or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) then
    alter role ops_astro_restore_drill nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end $$;

-- A passed drill, now, to the millisecond the API shows; a later pass moves
-- it forward and never back. The one row stays one.
create function ops.record_tested_restore() returns timestamptz
  language sql security definer set search_path = pg_catalog as $$
  insert into ops.last_tested_restore as t (one, at)
  values (true, date_trunc('milliseconds', now()))
  on conflict (one) do update set at = greatest(t.at, excluded.at)
  returning at
$$;
revoke execute on function ops.record_tested_restore() from public;

grant usage on schema ops to ops_astro_restore_drill;
grant execute on function ops.record_tested_restore() to ops_astro_restore_drill;

comment on role ops_astro_restore_drill is
  'Restore drill identity. Runs ops.record_tested_restore() alone; '
  'no read, no other write, no login of its own.';
