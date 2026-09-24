-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0031 two upgrade guards: no TEMPORARY for the application, and no cap
-- already past its ceiling.
--
-- Both were carried forward unchecked by a database brought up to date with
-- `db:migrate` alone (Sol round 3, SOL-R3-2 and SOL-R3-1; Nathan approved as
-- FR2-P3). Each was reproduced on a database built at 0028 and migrated
-- (`tests/runtime/final-r2-dbtest-upgrade-guards.test.ts`).
--
-- 1. SOL-R3-2. PostgreSQL grants TEMPORARY on a new database to PUBLIC. A
--    temporary table lives in `pg_temp`, outside every schema the application
--    is refused CREATE in, and on a pooled backend it outlives the transaction
--    and can shadow `records` for the next tenant (DATA.md). db-up.sh and the
--    test harness revoke it where the database is made (R2-AUTHORITY-61), but a
--    database made before that revoke kept it. Here it is revoked on the
--    current database from PUBLIC, from the application group and from every
--    login in that group, whichever of them held it. Revoking what is not held
--    is a no-op, so this is idempotent, and db-up.sh keeps its own revoke for
--    new databases. A backend that already made a temporary table keeps its
--    temporary schema until it disconnects, so a running API is restarted
--    after the upgrade, as after any migration.
--
-- 2. SOL-R3-1. 0029 closed the hole through which an application writer
--    committed a cap past its ceiling, by clearing or switching
--    `app.business_id` before commit, but a total committed through that hole
--    at 0028 was never judged. 0025's check is repeated here once against
--    every cap: an installation holding a cap committed past its limit fails
--    this migration, with the cap and business named, changes no row, and is
--    not recorded as having applied 0031. Rows are never deleted or rewritten
--    to make it pass; the owner resolves the over-ceiling total and migrates
--    again.
--
-- Grants other than TEMPORARY are unchanged.

do $$
declare
  over record;
begin
  select c.business_id, c.id, c.limit_minor, sum(e.held_minor::numeric + e.actual_minor::numeric) as committed
    into over
    from public.budget_caps c
    join public.task_envelopes e on e.business_id = c.business_id and e.cap_id = c.id
   group by c.business_id, c.id, c.limit_minor
  having sum(e.held_minor::numeric + e.actual_minor::numeric) > c.limit_minor
   limit 1;
  if found then
    raise exception 'budget_caps: cap % in business % is committed to % past its ceiling %',
      over.id, over.business_id, over.committed, over.limit_minor
      using errcode = 'check_violation', constraint = 'budget_caps_ceiling';
  end if;
end;
$$;

do $$
declare
  login record;
begin
  execute format('revoke temporary on database %I from public', current_database());
  execute format('revoke temporary on database %I from ops_astro_app', current_database());
  for login in
    select r.rolname
      from pg_auth_members m
      join pg_roles g on g.oid = m.roleid
      join pg_roles r on r.oid = m.member
     where g.rolname = 'ops_astro_app'
  loop
    -- A login dropped after this loop read it has nothing left to revoke (FR8-0031).
    begin
      execute format('revoke temporary on database %I from %I', current_database(), login.rolname);
    exception when undefined_object then
      null;
    end;
  end loop;
end;
$$;
