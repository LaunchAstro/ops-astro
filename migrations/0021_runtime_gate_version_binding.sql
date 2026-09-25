-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0021 a gate's run, step and lineage belong to its version.
--
-- 0011 gave `gates` a foreign key to each of its version, run, step and
-- lineage, all keyed on `(business_id, id)`, and nothing said they had to
-- agree. A run of another proposal in the same business satisfies
-- `gates_run_fkey` on its own, and `decide` takes the task from the gate's run,
-- so approving such a gate locks and charges the other proposal's task (G01).
-- Tenancy does not catch it, because both proposals are in one business.
--
-- The same argument as 0017, one table further on: the independent barrier is
-- the server's, so a writer that forgets the binding meets a constraint. The
-- composite keys need unique keys to point at, which the three indexes are;
-- the whole migration is additive and rewrites nothing. Adding a foreign key
-- validates every existing row, so a database holding a mismatched gate fails
-- here rather than keeping it. The check, run before applying, is:
--
--   select g.id from public.gates g
--     left join public.planned_runs r
--       on r.business_id = g.business_id and r.id = g.run_id and r.version_id = g.version_id
--     left join public.planned_steps s
--       on s.business_id = g.business_id and s.id = g.step_id and s.run_id = g.run_id
--     left join public.proposal_versions v
--       on v.business_id = g.business_id and v.id = g.version_id and v.lineage_id = g.lineage_id
--    where r.id is null or s.id is null or v.id is null;
--
-- and it returns no rows on any database the first slice has written.

create unique index planned_runs_id_version_idx
  on public.planned_runs (business_id, id, version_id);

create unique index planned_steps_id_run_idx
  on public.planned_steps (business_id, id, run_id);

-- The gate's run plans the gate's version.
alter table public.gates
  add constraint gates_run_in_same_version
    foreign key (business_id, run_id, version_id)
    references public.planned_runs (business_id, id, version_id);

-- The gate's step is a step of the gate's run.
alter table public.gates
  add constraint gates_step_in_same_run
    foreign key (business_id, step_id, run_id)
    references public.planned_steps (business_id, id, run_id);

-- The gate's version is a version of the gate's lineage. The unique key it
-- points at is 0017's `proposal_versions_id_lineage_idx`.
alter table public.gates
  add constraint gates_version_in_same_lineage
    foreign key (business_id, version_id, lineage_id)
    references public.proposal_versions (business_id, id, lineage_id);
