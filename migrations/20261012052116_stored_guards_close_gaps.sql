-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Eight storage guards that let a row past what they promise, each closed
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
-- 8. A client's name and a connection's label refuse hidden characters (below).
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
-- business is still refused by its foreign key, by name. Deferrable, so a
-- transaction that writes the run before what it rests on can ask for the
-- check at commit (`set constraints ... deferred`); immediate otherwise.
create constraint trigger planned_runs_origin_is_approved
  after insert on public.planned_runs
  deferrable initially immediate
  for each row when (new.origin_occurrence_id is not null)
  execute function public.planned_runs_origin_is_approved();

-- 8. A client's name and a connection's label are drawn on screens every
--    member with the key can open, so neither may hide text or pass for
--    another (#1000). A connection's label takes the signal grammar
--    (`signal_text`, 20261005201200) in place of 20261005153051's deny-list.
--    A client's name stays open to every script, as `drawn_name`: it refuses
--    control, format, private-use, line and paragraph separator characters
--    (Cc, Cf, Co, Zl, Zp) and every space but U+0020 (Zs), unassigned code
--    points (Cn, `unicode_assigned`), variation selectors and tags, the
--    characters that draw as nothing (the combining grapheme joiner, the
--    Hangul and Khitan fillers, the braille and hieroglyph blanks, the null
--    notehead), a leading combining mark (Mn, Mc, Me) and a run of five or
--    more of them. The classes are Unicode 16's general categories, written
--    out as ranges, since Postgres regular expressions name no category; a
--    code point newer than the server's Unicode is unassigned to it. A stored
--    row either refuses is named by id and fails this migration; no row is
--    rewritten.

create domain public.drawn_name as text
  constraint drawn_name_shape check (
    unicode_assigned(value)
    and value !~ '[\u0001-\u001F\u007F-\u00A0\u00AD\u034F\u0600-\u0605\u061C\u06DD\u070F\u0890-\u0891\u08E2\u115F-\u1160\u1680\u180B-\u180F\u2000-\u200F\u2028-\u202F\u205F-\u2064\u2066-\u206F\u2800\u3000\u3164\uE000-\uF8FF\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\U000110BD\U000110CD\U00013430-\U0001343F\U00013441-\U00013442\U00016FE4\U0001BCA0-\U0001BCA3\U0001D159\U0001D173-\U0001D17A\U000E0000-\U000E0FFF\U000F0000-\U000FFFFD\U00100000-\U0010FFFD]'
    and value !~ '^[\u0300-\u036F\u0483-\u0489\u0591-\u05BD\u05BF\u05C1-\u05C2\u05C4-\u05C5\u05C7\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7-\u06E8\u06EA-\u06ED\u0711\u0730-\u074A\u07A6-\u07B0\u07EB-\u07F3\u07FD\u0816-\u0819\u081B-\u0823\u0825-\u0827\u0829-\u082D\u0859-\u085B\u0897-\u089F\u08CA-\u08E1\u08E3-\u0903\u093A-\u093C\u093E-\u094F\u0951-\u0957\u0962-\u0963\u0981-\u0983\u09BC\u09BE-\u09C4\u09C7-\u09C8\u09CB-\u09CD\u09D7\u09E2-\u09E3\u09FE\u0A01-\u0A03\u0A3C\u0A3E-\u0A42\u0A47-\u0A48\u0A4B-\u0A4D\u0A51\u0A70-\u0A71\u0A75\u0A81-\u0A83\u0ABC\u0ABE-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AE2-\u0AE3\u0AFA-\u0AFF\u0B01-\u0B03\u0B3C\u0B3E-\u0B44\u0B47-\u0B48\u0B4B-\u0B4D\u0B55-\u0B57\u0B62-\u0B63\u0B82\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD7\u0C00-\u0C04\u0C3C\u0C3E-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55-\u0C56\u0C62-\u0C63\u0C81-\u0C83\u0CBC\u0CBE-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5-\u0CD6\u0CE2-\u0CE3\u0CF3\u0D00-\u0D03\u0D3B-\u0D3C\u0D3E-\u0D44\u0D46-\u0D48\u0D4A-\u0D4D\u0D57\u0D62-\u0D63\u0D81-\u0D83\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DF2-\u0DF3\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u0EB1\u0EB4-\u0EBC\u0EC8-\u0ECE\u0F18-\u0F19\u0F35\u0F37\u0F39\u0F3E-\u0F3F\u0F71-\u0F84\u0F86-\u0F87\u0F8D-\u0F97\u0F99-\u0FBC\u0FC6\u102B-\u103E\u1056-\u1059\u105E-\u1060\u1062-\u1064\u1067-\u106D\u1071-\u1074\u1082-\u108D\u108F\u109A-\u109D\u135D-\u135F\u1712-\u1715\u1732-\u1734\u1752-\u1753\u1772-\u1773\u17B4-\u17D3\u17DD\u180B-\u180D\u180F\u1885-\u1886\u18A9\u1920-\u192B\u1930-\u193B\u1A17-\u1A1B\u1A55-\u1A5E\u1A60-\u1A7C\u1A7F\u1AB0-\u1ACE\u1B00-\u1B04\u1B34-\u1B44\u1B6B-\u1B73\u1B80-\u1B82\u1BA1-\u1BAD\u1BE6-\u1BF3\u1C24-\u1C37\u1CD0-\u1CD2\u1CD4-\u1CE8\u1CED\u1CF4\u1CF7-\u1CF9\u1DC0-\u1DFF\u20D0-\u20F0\u2CEF-\u2CF1\u2D7F\u2DE0-\u2DFF\u302A-\u302F\u3099-\u309A\uA66F-\uA672\uA674-\uA67D\uA69E-\uA69F\uA6F0-\uA6F1\uA802\uA806\uA80B\uA823-\uA827\uA82C\uA880-\uA881\uA8B4-\uA8C5\uA8E0-\uA8F1\uA8FF\uA926-\uA92D\uA947-\uA953\uA980-\uA983\uA9B3-\uA9C0\uA9E5\uAA29-\uAA36\uAA43\uAA4C-\uAA4D\uAA7B-\uAA7D\uAAB0\uAAB2-\uAAB4\uAAB7-\uAAB8\uAABE-\uAABF\uAAC1\uAAEB-\uAAEF\uAAF5-\uAAF6\uABE3-\uABEA\uABEC-\uABED\uFB1E\uFE00-\uFE0F\uFE20-\uFE2F\U000101FD\U000102E0\U00010376-\U0001037A\U00010A01-\U00010A03\U00010A05-\U00010A06\U00010A0C-\U00010A0F\U00010A38-\U00010A3A\U00010A3F\U00010AE5-\U00010AE6\U00010D24-\U00010D27\U00010D69-\U00010D6D\U00010EAB-\U00010EAC\U00010EFC-\U00010EFF\U00010F46-\U00010F50\U00010F82-\U00010F85\U00011000-\U00011002\U00011038-\U00011046\U00011070\U00011073-\U00011074\U0001107F-\U00011082\U000110B0-\U000110BA\U000110C2\U00011100-\U00011102\U00011127-\U00011134\U00011145-\U00011146\U00011173\U00011180-\U00011182\U000111B3-\U000111C0\U000111C9-\U000111CC\U000111CE-\U000111CF\U0001122C-\U00011237\U0001123E\U00011241\U000112DF-\U000112EA\U00011300-\U00011303\U0001133B-\U0001133C\U0001133E-\U00011344\U00011347-\U00011348\U0001134B-\U0001134D\U00011357\U00011362-\U00011363\U00011366-\U0001136C\U00011370-\U00011374\U000113B8-\U000113C0\U000113C2\U000113C5\U000113C7-\U000113CA\U000113CC-\U000113D0\U000113D2\U000113E1-\U000113E2\U00011435-\U00011446\U0001145E\U000114B0-\U000114C3\U000115AF-\U000115B5\U000115B8-\U000115C0\U000115DC-\U000115DD\U00011630-\U00011640\U000116AB-\U000116B7\U0001171D-\U0001172B\U0001182C-\U0001183A\U00011930-\U00011935\U00011937-\U00011938\U0001193B-\U0001193E\U00011940\U00011942-\U00011943\U000119D1-\U000119D7\U000119DA-\U000119E0\U000119E4\U00011A01-\U00011A0A\U00011A33-\U00011A39\U00011A3B-\U00011A3E\U00011A47\U00011A51-\U00011A5B\U00011A8A-\U00011A99\U00011C2F-\U00011C36\U00011C38-\U00011C3F\U00011C92-\U00011CA7\U00011CA9-\U00011CB6\U00011D31-\U00011D36\U00011D3A\U00011D3C-\U00011D3D\U00011D3F-\U00011D45\U00011D47\U00011D8A-\U00011D8E\U00011D90-\U00011D91\U00011D93-\U00011D97\U00011EF3-\U00011EF6\U00011F00-\U00011F01\U00011F03\U00011F34-\U00011F3A\U00011F3E-\U00011F42\U00011F5A\U00013440\U00013447-\U00013455\U0001611E-\U0001612F\U00016AF0-\U00016AF4\U00016B30-\U00016B36\U00016F4F\U00016F51-\U00016F87\U00016F8F-\U00016F92\U00016FE4\U00016FF0-\U00016FF1\U0001BC9D-\U0001BC9E\U0001CF00-\U0001CF2D\U0001CF30-\U0001CF46\U0001D165-\U0001D169\U0001D16D-\U0001D172\U0001D17B-\U0001D182\U0001D185-\U0001D18B\U0001D1AA-\U0001D1AD\U0001D242-\U0001D244\U0001DA00-\U0001DA36\U0001DA3B-\U0001DA6C\U0001DA75\U0001DA84\U0001DA9B-\U0001DA9F\U0001DAA1-\U0001DAAF\U0001E000-\U0001E006\U0001E008-\U0001E018\U0001E01B-\U0001E021\U0001E023-\U0001E024\U0001E026-\U0001E02A\U0001E08F\U0001E130-\U0001E136\U0001E2AE\U0001E2EC-\U0001E2EF\U0001E4EC-\U0001E4EF\U0001E5EE-\U0001E5EF\U0001E8D0-\U0001E8D6\U0001E944-\U0001E94A\U000E0100-\U000E01EF]'
    and value !~ '[\u0300-\u036F\u0483-\u0489\u0591-\u05BD\u05BF\u05C1-\u05C2\u05C4-\u05C5\u05C7\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7-\u06E8\u06EA-\u06ED\u0711\u0730-\u074A\u07A6-\u07B0\u07EB-\u07F3\u07FD\u0816-\u0819\u081B-\u0823\u0825-\u0827\u0829-\u082D\u0859-\u085B\u0897-\u089F\u08CA-\u08E1\u08E3-\u0903\u093A-\u093C\u093E-\u094F\u0951-\u0957\u0962-\u0963\u0981-\u0983\u09BC\u09BE-\u09C4\u09C7-\u09C8\u09CB-\u09CD\u09D7\u09E2-\u09E3\u09FE\u0A01-\u0A03\u0A3C\u0A3E-\u0A42\u0A47-\u0A48\u0A4B-\u0A4D\u0A51\u0A70-\u0A71\u0A75\u0A81-\u0A83\u0ABC\u0ABE-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AE2-\u0AE3\u0AFA-\u0AFF\u0B01-\u0B03\u0B3C\u0B3E-\u0B44\u0B47-\u0B48\u0B4B-\u0B4D\u0B55-\u0B57\u0B62-\u0B63\u0B82\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD7\u0C00-\u0C04\u0C3C\u0C3E-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55-\u0C56\u0C62-\u0C63\u0C81-\u0C83\u0CBC\u0CBE-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5-\u0CD6\u0CE2-\u0CE3\u0CF3\u0D00-\u0D03\u0D3B-\u0D3C\u0D3E-\u0D44\u0D46-\u0D48\u0D4A-\u0D4D\u0D57\u0D62-\u0D63\u0D81-\u0D83\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DF2-\u0DF3\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u0EB1\u0EB4-\u0EBC\u0EC8-\u0ECE\u0F18-\u0F19\u0F35\u0F37\u0F39\u0F3E-\u0F3F\u0F71-\u0F84\u0F86-\u0F87\u0F8D-\u0F97\u0F99-\u0FBC\u0FC6\u102B-\u103E\u1056-\u1059\u105E-\u1060\u1062-\u1064\u1067-\u106D\u1071-\u1074\u1082-\u108D\u108F\u109A-\u109D\u135D-\u135F\u1712-\u1715\u1732-\u1734\u1752-\u1753\u1772-\u1773\u17B4-\u17D3\u17DD\u180B-\u180D\u180F\u1885-\u1886\u18A9\u1920-\u192B\u1930-\u193B\u1A17-\u1A1B\u1A55-\u1A5E\u1A60-\u1A7C\u1A7F\u1AB0-\u1ACE\u1B00-\u1B04\u1B34-\u1B44\u1B6B-\u1B73\u1B80-\u1B82\u1BA1-\u1BAD\u1BE6-\u1BF3\u1C24-\u1C37\u1CD0-\u1CD2\u1CD4-\u1CE8\u1CED\u1CF4\u1CF7-\u1CF9\u1DC0-\u1DFF\u20D0-\u20F0\u2CEF-\u2CF1\u2D7F\u2DE0-\u2DFF\u302A-\u302F\u3099-\u309A\uA66F-\uA672\uA674-\uA67D\uA69E-\uA69F\uA6F0-\uA6F1\uA802\uA806\uA80B\uA823-\uA827\uA82C\uA880-\uA881\uA8B4-\uA8C5\uA8E0-\uA8F1\uA8FF\uA926-\uA92D\uA947-\uA953\uA980-\uA983\uA9B3-\uA9C0\uA9E5\uAA29-\uAA36\uAA43\uAA4C-\uAA4D\uAA7B-\uAA7D\uAAB0\uAAB2-\uAAB4\uAAB7-\uAAB8\uAABE-\uAABF\uAAC1\uAAEB-\uAAEF\uAAF5-\uAAF6\uABE3-\uABEA\uABEC-\uABED\uFB1E\uFE00-\uFE0F\uFE20-\uFE2F\U000101FD\U000102E0\U00010376-\U0001037A\U00010A01-\U00010A03\U00010A05-\U00010A06\U00010A0C-\U00010A0F\U00010A38-\U00010A3A\U00010A3F\U00010AE5-\U00010AE6\U00010D24-\U00010D27\U00010D69-\U00010D6D\U00010EAB-\U00010EAC\U00010EFC-\U00010EFF\U00010F46-\U00010F50\U00010F82-\U00010F85\U00011000-\U00011002\U00011038-\U00011046\U00011070\U00011073-\U00011074\U0001107F-\U00011082\U000110B0-\U000110BA\U000110C2\U00011100-\U00011102\U00011127-\U00011134\U00011145-\U00011146\U00011173\U00011180-\U00011182\U000111B3-\U000111C0\U000111C9-\U000111CC\U000111CE-\U000111CF\U0001122C-\U00011237\U0001123E\U00011241\U000112DF-\U000112EA\U00011300-\U00011303\U0001133B-\U0001133C\U0001133E-\U00011344\U00011347-\U00011348\U0001134B-\U0001134D\U00011357\U00011362-\U00011363\U00011366-\U0001136C\U00011370-\U00011374\U000113B8-\U000113C0\U000113C2\U000113C5\U000113C7-\U000113CA\U000113CC-\U000113D0\U000113D2\U000113E1-\U000113E2\U00011435-\U00011446\U0001145E\U000114B0-\U000114C3\U000115AF-\U000115B5\U000115B8-\U000115C0\U000115DC-\U000115DD\U00011630-\U00011640\U000116AB-\U000116B7\U0001171D-\U0001172B\U0001182C-\U0001183A\U00011930-\U00011935\U00011937-\U00011938\U0001193B-\U0001193E\U00011940\U00011942-\U00011943\U000119D1-\U000119D7\U000119DA-\U000119E0\U000119E4\U00011A01-\U00011A0A\U00011A33-\U00011A39\U00011A3B-\U00011A3E\U00011A47\U00011A51-\U00011A5B\U00011A8A-\U00011A99\U00011C2F-\U00011C36\U00011C38-\U00011C3F\U00011C92-\U00011CA7\U00011CA9-\U00011CB6\U00011D31-\U00011D36\U00011D3A\U00011D3C-\U00011D3D\U00011D3F-\U00011D45\U00011D47\U00011D8A-\U00011D8E\U00011D90-\U00011D91\U00011D93-\U00011D97\U00011EF3-\U00011EF6\U00011F00-\U00011F01\U00011F03\U00011F34-\U00011F3A\U00011F3E-\U00011F42\U00011F5A\U00013440\U00013447-\U00013455\U0001611E-\U0001612F\U00016AF0-\U00016AF4\U00016B30-\U00016B36\U00016F4F\U00016F51-\U00016F87\U00016F8F-\U00016F92\U00016FE4\U00016FF0-\U00016FF1\U0001BC9D-\U0001BC9E\U0001CF00-\U0001CF2D\U0001CF30-\U0001CF46\U0001D165-\U0001D169\U0001D16D-\U0001D172\U0001D17B-\U0001D182\U0001D185-\U0001D18B\U0001D1AA-\U0001D1AD\U0001D242-\U0001D244\U0001DA00-\U0001DA36\U0001DA3B-\U0001DA6C\U0001DA75\U0001DA84\U0001DA9B-\U0001DA9F\U0001DAA1-\U0001DAAF\U0001E000-\U0001E006\U0001E008-\U0001E018\U0001E01B-\U0001E021\U0001E023-\U0001E024\U0001E026-\U0001E02A\U0001E08F\U0001E130-\U0001E136\U0001E2AE\U0001E2EC-\U0001E2EF\U0001E4EC-\U0001E4EF\U0001E5EE-\U0001E5EF\U0001E8D0-\U0001E8D6\U0001E944-\U0001E94A\U000E0100-\U000E01EF]{5,}'
  );

do $$
declare
  named_clients text;
  named_connections text;
begin
  select string_agg(id::text, ', ' order by id) into named_clients
    from (select id from public.clients
           where not pg_input_is_valid(name, 'public.drawn_name') order by id limit 20) c;
  select string_agg(id::text, ', ' order by id) into named_connections
    from (select id from public.connections
           where not pg_input_is_valid(label, 'public.signal_text') order by id limit 20) c;
  if named_clients is not null or named_connections is not null then
    raise exception 'drawn names: rename these rows first; clients %, connections %',
      coalesce(named_clients, 'none'), coalesce(named_connections, 'none')
      using errcode = 'check_violation';
  end if;
end;
$$;

alter table public.clients alter column name type public.drawn_name;

alter table public.connections
  drop constraint connections_label_shape,
  alter column label type public.signal_text;
