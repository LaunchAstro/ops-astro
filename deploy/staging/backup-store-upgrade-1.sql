-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The first rule added to the backup store after backup-store.sql, run by
-- the store's admin after it, from the restore runbook (a store made earlier
-- runs it then):
--
--   \i deploy/staging/backup-store-upgrade-1.sql
--
-- A passed drill names its target's major and its table count (OW-059.2):
-- the earlier check compared them, and a comparison with a null passes a
-- CHECK. A store that has the rule already is left as it is, so the file can
-- run more than once. A pass the earlier rule let in without either field
-- stops the rule being added, and the store's admin is told so.

do $$ begin
  if not exists (
    select from pg_constraint
    where conrelid = 'backups.drills'::regclass and conname = 'drills_pass_names_its_restore'
  ) then
    alter table backups.drills add constraint drills_pass_names_its_restore check (
      outcome = 'failed' or (
        archive_taken_at is not null and source_major is not null and target_major is not null
        and tables is not null and target_major = production_major and tables > 0));
  end if;
end $$;
