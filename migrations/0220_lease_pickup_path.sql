-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0220 a lease is taken only through the pickup path (SL11-30). 0218 refuses
-- a reviewed output its lease's holder did not propose, and that check is only
-- as strong as `leases.holder_actor_id`. 0013 granted the application role
-- insert and update on the whole table, so a direct statement could rewrite a
-- lease's holder, or insert a lease naming any actor, and then mark that
-- actor's version as the lease's work.
--
-- The application role now updates only the three columns the product moves:
-- `expires_at` (heartbeat), and `state` and `released_at` (hand-back, fence,
-- sweep, cancel, a budget stop). It inserts no lease. Pickup takes its lease
-- through `take_lease`, which runs as its definer and checks inside, against
-- the caller's own business (`app_business_id()`, never an argument):
--   * the reservation is claimable: held, bound to no lease, its attempt
--     reserved and unmarked, its version's gate approved, the version current,
--     its lineage live and its task not in the trash;
--   * the claimant's authority, read as pickup reads it, at the call's own
--     instant: a person claims as their own active actor, under their own
--     name, under a live write on the task (who approved is not asked); an
--     active agent claims, named for the latest approval's person, under
--     the delegation minted for this lease (its own, on this task, from the
--     approving person, live, unbound, ending with the lease), and the
--     approving person holds read, comment and write business-wide;
--   * the expiry is after now and within a lease's lifetime (8 hours).
-- The fence is computed here, past every lease the task has had. Grants are
-- judged as `EFFECTIVE` judges them (core-records/src/authority/grants.ts).
-- Pickup still checks all of this under its locks first, with its own
-- refusals; this is the barrier behind it. A call with any required argument
-- null takes nothing and answers null (a null delegation is a person's claim).
--
-- What it does not close: the application role still writes delegations,
-- grants, gate decisions and actors, so a lease taken here is only as
-- trustworthy as those rows. The holder of a lease already taken is never
-- rewritten. Putting the delegation mint behind this path is the next step.
--
-- PUBLIC may not execute it; the application group may. Its search path is
-- pinned and every name in it is qualified. Protected: authority, approval
-- gate. No table or policy changes.

revoke insert, update on public.leases from ops_astro_app;
grant update (expires_at, state, released_at) on public.leases to ops_astro_app;

create function public.take_lease(
  lease uuid,
  reservation uuid,
  delegation uuid,
  holder uuid,
  authorised_by uuid,
  expires timestamptz,
  collection_key text
) returns bigint
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
as $$
declare
  business constant uuid := public.app_business_id();
  work record;
  approver record;
  subject_person uuid;
  subject_actor uuid;
  needed text[];
  on_task boolean;
  covered integer;
  next_fence bigint;
begin
  if lease is null or reservation is null or holder is null or authorised_by is null
     or expires is null or collection_key is null then
    return null;
  end if;
  if business is null then
    raise exception 'leases: a lease is taken in the caller''s own business'
      using errcode = 'insufficient_privilege';
  end if;

  select run.id as run_id, run.task_id, res.version_id into work
    from public.reservations res
    join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
    join public.proposal_versions ver
      on ver.business_id = res.business_id and ver.id = res.version_id
    join public.proposal_lineages lin on lin.business_id = run.business_id and lin.id = run.lineage_id
    join public.gates g on g.business_id = res.business_id and g.version_id = res.version_id
    join public.records task on task.business_id = run.business_id and task.id = run.task_id
   where res.business_id = business and res.id = reservation
     and res.state = 'held' and res.lease_id is null
     and g.state = 'approved' and lin.state = 'live' and ver.superseded_at is null
     and task.deleted_at is null
     and exists (select 1 from public.attempts att
                  where att.business_id = res.business_id and att.reservation_id = res.id
                    and att.state = 'reserved' and not att.dispatch_marker and not att.observed);
  if not found then
    raise exception 'leases: the reservation is not claimable' using errcode = 'check_violation';
  end if;
  if expires <= now() or expires > now() + interval '8 hours' then
    raise exception 'leases: the expiry is outside a lease''s lifetime'
      using errcode = 'check_violation';
  end if;

  select d.decided_by_person_id, d.decided_by_actor_id into approver
    from public.gate_decisions d
   where d.business_id = business and d.version_id = work.version_id and d.decision = 'approve'
   order by d.seq desc
   limit 1;

  if delegation is null then
    -- A person, as their own actor and under their own name, under their own
    -- live write on this task. Who approved the work is not their authority.
    select a.person_id into subject_person
      from public.actors a
     where a.business_id = business and a.id = holder and a.kind = 'person' and a.active
       and a.person_id = authorised_by;
    subject_actor := holder;
    needed := array['write'];
    on_task := true;
  elsif exists (select 1 from public.delegations d
                 where d.business_id = business and d.id = delegation
                   and d.agent_actor_id = holder and d.delegate_person_id = authorised_by
                   and exists (select 1 from public.actors x
                                where x.business_id = business and x.id = holder and x.active)
                   and d.minted_by_actor_id = approver.decided_by_actor_id
                   and d.purpose_scope_kind = 'record' and d.purpose_scope_id = work.task_id
                   and collection_key = any (d.collections)
                   and d.expires_at = expires and d.revoked_at is null and d.settled_at is null
                   and not exists (select 1 from public.leases l
                                    where l.business_id = d.business_id and l.delegation_id = d.id))
  then
    -- An agent, under the approving person's business-wide grants.
    subject_person := authorised_by;
    subject_actor := approver.decided_by_actor_id;
    needed := array['read', 'comment', 'write'];
    on_task := false;
  end if;

  with recursive effective as (
    select g.*, 1 as depth
      from public.grants g
     where g.business_id = business and g.parent_grant_id is null
       and g.revoked_at is null and (g.expires_at is null or g.expires_at > clock_timestamp())
    union all
    select c.*, p.depth + 1
      from public.grants c
      join effective p on p.id = c.parent_grant_id
     where c.business_id = business and p.depth < 8
       and c.revoked_at is null and (c.expires_at is null or c.expires_at > clock_timestamp())
       and p.can_delegate and c.collection = p.collection and c.action = p.action
       and (p.scope_kind = 'business'
            or (c.scope_kind = p.scope_kind and c.scope_id is not distinct from p.scope_id))
       and (not c.can_delegate or p.may_permit_delegation)
       and not c.may_permit_delegation
       and (p.expires_at is null or (c.expires_at is not null and c.expires_at <= p.expires_at))
  )
  select count(distinct e.action) into covered
    from effective e
   where e.collection = collection_key and e.action = any (needed)
     and ((e.subject_kind = 'person' and e.subject_id = subject_person)
          or (e.subject_kind = 'actor' and e.subject_id = subject_actor))
     and (e.scope_kind = 'business'
          or (on_task and e.scope_kind = 'record' and e.scope_id = work.task_id));

  if subject_person is null or covered < cardinality(needed)
     or (delegation is not null and approver.decided_by_person_id is distinct from authorised_by)
  then
    raise exception 'leases: the claimant''s authority does not cover this lease'
      using errcode = 'insufficient_privilege';
  end if;

  select coalesce(max(l.fence), 0) + 1 into next_fence
    from public.leases l
   where l.business_id = business and l.task_id = work.task_id;
  insert into public.leases
    (business_id, id, task_id, run_id, reservation_id, delegation_id, holder_actor_id,
     authorised_by_person_id, fence, expires_at)
  values (business, lease, work.task_id, work.run_id, reservation, delegation, holder,
          authorised_by, next_fence, expires);
  return next_fence;
end;
$$;

revoke all on function public.take_lease(uuid, uuid, uuid, uuid, uuid, timestamptz, text) from public;
grant execute on function public.take_lease(uuid, uuid, uuid, uuid, uuid, timestamptz, text)
  to ops_astro_app;
