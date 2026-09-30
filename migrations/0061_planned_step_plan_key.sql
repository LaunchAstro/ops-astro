-- SPDX-License-Identifier: AGPL-3.0-only
--
-- AW-06 (ORCH41 decision (a)): the plan step a run's step was proposed under.
--
-- Optional. A proposal may name a step of the task's bound plan record
-- (0058's `plan_records`, the plan AW-04's accept bound to its decision); the
-- command checks the key against that record under the task lock and refuses
-- a key the plan lacks. The execution graph puts the run under that step, and
-- shows a run naming none, or a key the bound plan lacks, as unplanned.
--
-- The key's spelling is the plan record's own (`plan-record.ts`, `KEY`). The
-- column is never a reference: a plan bound later may lack the key, and the
-- run then shows unplanned rather than losing what it was proposed under.

alter table public.planned_steps
  add column plan_step_key text,
  add constraint planned_steps_plan_step_key_shape
    check (plan_step_key is null or plan_step_key ~ '^[a-z][a-z0-9_-]{0,62}$');
