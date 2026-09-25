-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0017 one task owns a lineage, its runs and its versions.
--
-- 0010 gave `planned_runs` a foreign key to its lineage and a foreign key to
-- its task, and nothing said the two had to agree. Each key is satisfied on
-- its own by rows that describe two different pieces of work: a proposal
-- authorised on task A, superseding a lineage that belongs to task B, and
-- inserting a run that names A's task and B's lineage. Both parents exist, so
-- both keys pass. Tenancy does not catch it either, because A and B are in one
-- business.
--
-- `propose` refuses that request now (R3). This is the independent second
-- barrier the contract asks for: the same fact, held by the server, so a
-- future writer that forgets the check meets a constraint rather than a
-- reviewer. Composite foreign keys need a unique key to point at, which is
-- what the two indexes below are; they are additive and rewrite nothing.

create unique index proposal_lineages_id_task_idx
  on public.proposal_lineages (business_id, id, task_id);

alter table public.planned_runs
  add constraint planned_runs_lineage_on_same_task
    foreign key (business_id, lineage_id, task_id)
    references public.proposal_lineages (business_id, id, task_id);

-- The version a run plans belongs to the run's lineage. Same argument: the
-- separate keys to `proposal_versions` and `proposal_lineages` each pass while
-- describing different lines of work.
create unique index proposal_versions_id_lineage_idx
  on public.proposal_versions (business_id, id, lineage_id);

alter table public.planned_runs
  add constraint planned_runs_version_in_same_lineage
    foreign key (business_id, version_id, lineage_id)
    references public.proposal_versions (business_id, id, lineage_id);
