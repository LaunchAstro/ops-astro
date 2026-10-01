-- SPDX-License-Identifier: AGPL-3.0-only
--
-- AW-01 J and C4: the occurrence role stamps the live change record.
--
-- 0203 revoked every public table from `ops_astro_occurrence` and granted it the
-- one insert on `planned_runs`. Main's 0065 then made 0035's `planned_runs_live`
-- trigger (`live_task_topic`, invoker's rights) upsert `live_changes` in the same
-- transaction, so the occurrence's run insert was refused on that table and no
-- occurrence started a run. The role gets what the upsert needs on that one
-- table, under the same tenancy policy, and nothing else.

grant select, insert, update on public.live_changes to ops_astro_occurrence;

comment on role ops_astro_occurrence is
  'The worker''s role for an automation occurrence''s run (AW-01 J). It inserts runs, '
  'reads a task''s revision and stamps the run''s task in live_changes (0065''s trigger), '
  'and holds nothing else; the application group may set it for the one insert, never '
  'inherit it.';
