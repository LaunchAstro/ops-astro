-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Seven storage guards that let a row past what they promise, each closed
-- here, since an applied migration is history and does not change.
--
-- 1. A CHECK passes when it evaluates to NULL. Four name a nullable column in
--    a comparison, so a row with that evidence missing was written: a keyed
--    delegation credential with no key id (0022), a dispatched step whose
--    marker is NULL, which also skips its composite key to the marked attempt
--    (0033), a marked attempt abandoned with no recorded abandonment (0037),
--    and a top-up answer with no amount or currency (0088). Each now says the
--    evidence is present. A stored row that breaks one fails this migration
--    by the constraint's name; no row is rewritten.
-- 2. 0031 revoked TEMPORARY from the application group's direct members
--    only. A login that holds the group through a middle role, and the middle
--    role, lose it here too: a temporary table on a pooled backend can shadow
--    `records` for the next tenant (docs/local/DATA.md).
-- 3. `take_lease` judged the claimant's grants under the collection its
--    caller named, so a business-wide write on another collection took a
--    lease on a task. A lease is on a task, so the collection is `task`;
--    any other is refused as uncovered. Nothing else in it changes, and it
--    stays its own role's, revoked from PUBLIC and executed by the
--    application group.
-- 4. When a privacy incident was found is what its 30-day assessment limit
--    runs from, so an update leaves `found_at` as it was recorded.
-- 5. An agent credential's revocation is stamped with the database clock,
--    as a standing mandate's is (20261006080000), not the time the writer
--    sends. The rest of the written-once guard is 0054's.
-- 6. The map frontier is a map's open, unblocked and unclaimed tickets. A
--    ticket an agent holds (`data.agent`, 0082) is claimed, and one its map's
--    completion archived (`data.archived_at`, 0077) is no open work; both
--    leave it. The rest of the refresh is 20261005125527's, and every live
--    map is refreshed once so the frontier holds now.
-- 7. An occurrence's run starts only from an approved occurrence, naming the
--    definition that occurrence's activation runs. The dispatch checks both
--    under the activation lock; any code may take the occurrence role for one
--    statement, so the database holds it too. The trigger reads occurrences
--    and activations, which that role may not, so it is a definer, pinned,
--    and it writes nothing.
--
-- Every new trigger function is revoked from PUBLIC and executed by no role.

alter table public.delegations
  drop constraint delegations_credential_key_matches_scheme,
  add constraint delegations_credential_key_matches_scheme check (
    (credential_scheme = 'legacy-random' and credential_key_id is null)
    or (credential_scheme = 'hmac-sha256-v1' and credential_key_id is not null
        and credential_key_id ~ '^[A-Za-z0-9._@/-]{1,64}$')
  );

alter table public.planned_steps
  drop constraint planned_steps_dispatch_named,
  add constraint planned_steps_dispatch_named check (
    (dispatched_at is null and dispatch_attempt_id is null and dispatch_marked is null)
    or (dispatched_at is not null and dispatch_attempt_id is not null and dispatch_marked is true)
  );

alter table public.attempts
  drop constraint attempts_marker_in_owning_state,
  add constraint attempts_marker_in_owning_state check (
    state = 'quarantined'
    or (not dispatch_marker and not observed)
    or (dispatch_marker and state in ('dispatched', 'settled', 'liability_unknown'))
    or (dispatch_marker and state = 'abandoned' and outcome is not distinct from 'abandoned')
  );

alter table public.budget_answers
  drop constraint budget_answers_shape,
  add constraint budget_answers_shape check (
    case kind
      when 'top_up' then amount_minor is not null and amount_minor > 0
                         and currency is not null and currency ~ '^[A-Z]{3}$'
      else amount_minor is null and currency is null and threshold_minor is null
           and second_person_id is null
    end
  );

do $$
declare
  login record;
begin
  for login in
    with recursive held (oid) as (
      select m.member from pg_auth_members m
        join pg_roles g on g.oid = m.roleid
       where g.rolname = 'ops_astro_app'
      union
      select m.member from pg_auth_members m join held h on h.oid = m.roleid
    )
    select r.rolname from held join pg_roles r on r.oid = held.oid
  loop
    -- A role dropped after this loop read it has nothing left to revoke, as in 0031.
    begin
      execute format('revoke temporary on database %I from %I', current_database(), login.rolname);
    exception when undefined_object then
      null;
    end;
  end loop;
end;
$$;

create or replace function public.take_lease(
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
    -- A person, as their own actor, under their own live write on this task.
    select a.person_id into subject_person
      from public.actors a
     where a.business_id = business and a.id = holder and a.kind = 'person' and a.active;
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

  -- A lease is on a task: grants under any other collection cover none.
  if approver.decided_by_person_id is distinct from authorised_by or subject_person is null
     or collection_key <> 'task' or covered < cardinality(needed) then
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

create function public.privacy_incidents_found_once() returns trigger
  language plpgsql
  as $$
  begin
    if new.found_at is distinct from old.found_at then
      raise exception 'IMMUTABLE_FIELD: when a privacy incident was found is written once'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end;
  $$;

revoke execute on function public.privacy_incidents_found_once() from public;

create trigger privacy_incidents_found_once
  before update on public.privacy_incidents
  for each row execute function public.privacy_incidents_found_once();

create or replace function public.agent_credentials_written_once() returns trigger
  language plpgsql
  as $$
  begin
    if (new.business_id, new.id, new.agent_actor_id, new.issued_by_person_id,
        new.issued_by_actor_id, new.purpose, new.scope, new.credential_hash,
        new.credential_scheme, new.credential_key_id, new.issued_at, new.expires_at)
       is distinct from
       (old.business_id, old.id, old.agent_actor_id, old.issued_by_person_id,
        old.issued_by_actor_id, old.purpose, old.scope, old.credential_hash,
        old.credential_scheme, old.credential_key_id, old.issued_at, old.expires_at)
       or (old.revoked_at is not null
           and (new.revoked_at, new.revoked_by_actor_id)
               is distinct from (old.revoked_at, old.revoked_by_actor_id)) then
      raise exception 'IMMUTABLE_FIELD: an agent credential is written once'
        using errcode = 'restrict_violation';
    end if;
    if old.revoked_at is null and new.revoked_at is not null then
      new.revoked_at := clock_timestamp();
    end if;
    return new;
  end;
  $$;

revoke execute on function public.agent_credentials_written_once() from public;

create or replace function public.map_summary_refresh(p_map uuid)
  returns void
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
declare
  v_business uuid := public.app_business_id();
  v_task_type uuid;
begin
  select t.id into v_task_type
    from public.record_types t where t.business_id = v_business and t.key = 'task';
  if v_task_type is null then return; end if;

  -- An id that is no live map and has no summary to drop is done here, with
  -- no lock, so writes under one ordinary parent do not queue on each other.
  if not exists (
    select 1 from public.records r
     where r.business_id = v_business and r.id = p_map and r.record_type_id = v_task_type
       and r.deleted_at is null and r.data ->> 'type' = 'map'
  ) and not exists (
    select 1 from public.map_summaries s where s.business_id = v_business and s.map_id = p_map
  ) then
    return;
  end if;

  -- One refresh of a map at a time, to the end of the transaction: each
  -- statement below then counts what an earlier writer committed, so two
  -- concurrent writes cannot each upsert a count missing the other's.
  perform pg_advisory_xact_lock(hashtextextended('map.summary:' || v_business || ':' || p_map, 0));

  if not exists (
    select 1 from public.records r
     where r.business_id = v_business and r.id = p_map and r.record_type_id = v_task_type
       and r.deleted_at is null and r.data ->> 'type' = 'map'
  ) then
    delete from public.map_summaries where business_id = v_business and map_id = p_map;
    delete from public.map_frontier where business_id = v_business and map_id = p_map;
    return;
  end if;

  delete from public.map_frontier where business_id = v_business and map_id = p_map;
  insert into public.map_frontier (business_id, id, map_id, ticket_id, position)
  select v_business, gen_random_uuid(), p_map, c.id,
         row_number() over (order by c.num_2 nulls last, c.created_at, c.id)
    from public.records c
    left join public.records s on s.business_id = c.business_id and s.id = c.uuid_1
   where c.business_id = v_business and c.record_type_id = v_task_type
     and c.uuid_4 = p_map and c.deleted_at is null
     and coalesce(s.data ->> 'machine_category', '') not in ('completed', 'cancelled')
     and c.uuid_2 is null and c.uuid_3 is null
     and c.data ->> 'agent' is null and c.data ->> 'archived_at' is null
     and not exists (
       select 1 from public.record_links l
         join public.records b on b.business_id = l.business_id and b.id = l.from_record_id
         left join public.records bs on bs.business_id = b.business_id and bs.id = b.uuid_1
        where l.business_id = v_business and l.link_type = 'blocks' and l.to_record_id = c.id
          and b.deleted_at is null
          and coalesce(bs.data ->> 'machine_category', '') not in ('completed', 'cancelled'));

  insert into public.map_summaries
    (business_id, id, map_id, version, open_tickets, closed_tickets, fog, out_of_scope, updated_at)
  select v_business, gen_random_uuid(), p_map,
         coalesce((select max(v.version) from public.map_versions v
                    where v.business_id = v_business and v.map_id = p_map), 0),
         count(*) filter (where s.data ->> 'machine_category' is distinct from 'completed'
                            and c.id is not null),
         count(*) filter (where s.data ->> 'machine_category' = 'completed'),
         (select count(*) from public.map_components m
           where m.business_id = v_business and m.map_id = p_map
             and m.kind = 'fog' and m.retired_version is null),
         (select count(*) from public.map_components m
           where m.business_id = v_business and m.map_id = p_map
             and m.kind = 'out_of_scope' and m.retired_version is null),
         now()
    from (select 1) as one
    left join public.records c
      on c.business_id = v_business and c.record_type_id = v_task_type
     and c.uuid_4 = p_map and c.deleted_at is null
    left join public.records s
      on s.business_id = v_business and s.id = c.uuid_1
  on conflict (business_id, map_id) do update
     set version = excluded.version,
         open_tickets = excluded.open_tickets,
         closed_tickets = excluded.closed_tickets,
         fog = excluded.fog,
         out_of_scope = excluded.out_of_scope,
         updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.map_summary_refresh(uuid) from public;

-- In id order, as map_summary_on_record refreshes, each under its own business
-- setting (the function reads it) and its per-map lock; the setting is restored.
do $$
declare
  v_was text := current_setting('app.business_id', true);
  v_map record;
begin
  for v_map in
    select r.business_id, r.id from public.records r
     where r.deleted_at is null and r.data ->> 'type' = 'map'
     order by r.id
  loop
    perform set_config('app.business_id', v_map.business_id::text, true);
    perform public.map_summary_refresh(v_map.id);
  end loop;
  perform set_config('app.business_id', coalesce(v_was, ''), true);
end;
$$;

create function public.planned_runs_origin_is_approved() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1 from public.activation_occurrences o
      join public.activations a on a.business_id = o.business_id and a.id = o.activation_id
     where o.business_id = new.business_id and o.id = new.origin_occurrence_id
       and o.outcome = 'approved' and a.definition_id = new.origin_definition_id
  ) then
    raise exception 'planned_runs: an occurrence''s run starts only from an approved occurrence of the definition its activation runs'
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

revoke all on function public.planned_runs_origin_is_approved() from public;

-- After the row's own checks and keys, so a run naming no occurrence of its
-- business is still refused by its foreign key, by name.
create constraint trigger planned_runs_origin_is_approved
  after insert on public.planned_runs
  for each row when (new.origin_occurrence_id is not null)
  execute function public.planned_runs_origin_is_approved();
