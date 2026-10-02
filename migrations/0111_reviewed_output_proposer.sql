-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0111 a reviewed output is its lease holder's work (AW-08). The application
-- may insert into `reviewed_outputs`, and 0108's trigger checked only that the
-- version and the lease's run are on the named lineage and that the version is
-- newer than the lease's work. A direct insert could still mark a person's
-- version, or another actor's, under an agent's lease, and approving it would
-- launch an effect no agent produced under that lease.
--
-- The trigger now also refuses a row whose version was not proposed by the
-- lease's holder. Both columns are written once: `proposed_by_actor_id` is
-- frozen by 0010's `proposal_versions_immutable`, and no code path rewrites a
-- lease's holder. The product's own marks pass: the handback's successor is
-- proposed as the session's actor, which the handback has checked is the
-- lease's holder, and `markRevision` marks only a revision its lease holder
-- proposed (N9-M2). The trigger stays security invoker and after the row, so
-- row security answers a write for another business first. No table, policy
-- or grant changes.

create or replace function public.reviewed_outputs_on_their_lineage() returns trigger
  language plpgsql
  as $$
begin
  -- The version is newer work than the lease's own, on one lineage: a lease never
  -- marks the version it ran under (its plan), so the plan accept fires nothing.
  if not exists (select 1 from public.proposal_versions v
                   join public.leases l on l.business_id = v.business_id and l.id = new.lease_id
                   join public.planned_runs r on r.business_id = l.business_id and r.id = l.run_id
                   join public.proposal_versions worked
                     on worked.business_id = r.business_id and worked.id = r.version_id
                  where v.business_id = new.business_id and v.id = new.version_id
                    and v.lineage_id = new.lineage_id and r.lineage_id = new.lineage_id
                    and v.version > worked.version) then
    raise exception 'reviewed_outputs: the version is on the named lineage, newer than the lease''s work'
      using errcode = 'check_violation';
  end if;
  -- The version is the work of the lease's holder: a person's version, or another
  -- actor's, is never the output of an agent's lease.
  if not exists (select 1 from public.proposal_versions v
                   join public.leases l on l.business_id = v.business_id and l.id = new.lease_id
                  where v.business_id = new.business_id and v.id = new.version_id
                    and v.proposed_by_actor_id = l.holder_actor_id) then
    raise exception 'reviewed_outputs: the lease''s holder proposed the version'
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

revoke execute on function public.reviewed_outputs_on_their_lineage() from public;
