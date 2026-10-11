-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Refuse the upgrade while an agent's proposal written before
-- 20261011155623 is still pending on a task its agent was launched on.
--
-- No such version records the credential it was made under, so whether it
-- was made under a Launch's delegation, and so which person four eyes
-- refuses, cannot be told from the database. 20261011155623 guessed from the
-- task, the agent and a time window, and two guesses are wrong: a revocation
-- whose transaction started before the proposal stamps a time before it, and
-- a proposal made under a pickup's delegation takes an overlapping Launch's.
-- So nothing is guessed: a person decides or cancels those proposals first.
--
-- The count covers every version 20261011155623 may link, the time window
-- dropped. Every pending file is applied in one transaction, so on a database
-- still crossing 20261011155623 this refusal rolls its backfill back with it,
-- and wherever this passes, that backfill found nothing to link.
--
-- No function is added, so there is nothing to revoke from public.

do $$
declare
  pending bigint;
begin
  select count(*) into pending
    from public.gates g
    join public.proposal_versions v on v.business_id = g.business_id and v.id = g.version_id
    join public.proposal_lineages pl on pl.business_id = v.business_id and pl.id = v.lineage_id
   where g.state = 'pending'
     and v.created_at < (select applied_at from ops.schema_migrations
                          where version = '20261011155623_proposal_launch_delegation')
     and exists (select 1 from public.task_launches l
                  where l.business_id = pl.business_id and l.task_id = pl.task_id
                    and l.agent_actor_id = v.proposed_by_actor_id);
  if pending > 0 then
    raise exception '% pending launch proposal(s) were made before a proposal recorded its Launch, so who may decide each cannot be told. A person must decide or cancel them, then run the migration again.', pending
      using errcode = 'object_not_in_prerequisite_state';
  end if;
end;
$$;
