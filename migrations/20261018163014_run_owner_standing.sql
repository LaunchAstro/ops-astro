-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Whether the owner started a run, recorded by the database as the run is
-- proposed and approved (#1909).
--
-- The `chatgpt-plan` route carries only runs the owner started: proposed by a
-- person then holding the owner role, and approved only by such people. It
-- read that standing from membership history, which the application role may
-- insert, update and delete, with times the application supplies, so an
-- ended, backdated owner membership written later made a member's run read
-- as the owner's.
--
-- * `proposal_versions.proposed_by_owner` and
--   `gate_decisions.decided_by_owner`: whether the proposer, or the decider,
--   holds an active owner membership as the row is inserted. A trigger sets
--   each, whatever the insert supplies. The membership row is read `for
--   share`, so a demotion in flight is waited on and its result read.
-- * Versions are immutable and decisions append only, so the stamp cannot be
--   edited afterwards; `proposal_versions_are_immutable` now names the new
--   column. Rows written before this migration keep a null, read as not the
--   owner's: no run before it reached the plan. Decisions are append only, so
--   a check holds every new one to a value; an old version may still be
--   superseded, so versions carry no such check, and the trigger is their
--   guarantee.

alter table public.proposal_versions add column proposed_by_owner boolean;
alter table public.gate_decisions add column decided_by_owner boolean;

alter table public.gate_decisions
  add constraint gate_decisions_owner_stamped check (decided_by_owner is not null) not valid;

create function public.proposal_versions_stamp_owner()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  perform 1
     from public.actors a
     join public.memberships m on m.business_id = a.business_id and m.person_id = a.person_id
    where a.business_id = new.business_id and a.id = new.proposed_by_actor_id
      and a.kind = 'person' and m.active and m.role_key = 'owner'
      for share of m;
  new.proposed_by_owner := found;
  return new;
end;
$$;

revoke execute on function public.proposal_versions_stamp_owner() from public;

create trigger proposal_versions_owner_stamp
  before insert on public.proposal_versions
  for each row execute function public.proposal_versions_stamp_owner();

create function public.gate_decisions_stamp_owner()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  perform 1
     from public.memberships m
    where m.business_id = new.business_id and m.person_id = new.decided_by_person_id
      and m.active and m.role_key = 'owner'
      for share;
  new.decided_by_owner := found;
  return new;
end;
$$;

revoke execute on function public.gate_decisions_stamp_owner() from public;

create trigger gate_decisions_owner_stamp
  before insert on public.gate_decisions
  for each row execute function public.gate_decisions_stamp_owner();

create or replace function public.proposal_versions_are_immutable() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'proposal_versions are immutable: version % cannot be deleted', old.id
      using errcode = 'restrict_violation';
  end if;
  if new.id is distinct from old.id
     or new.business_id is distinct from old.business_id
     or new.lineage_id is distinct from old.lineage_id
     or new.version is distinct from old.version
     or new.payload is distinct from old.payload
     or new.payload_digest is distinct from old.payload_digest
     or new.purpose is distinct from old.purpose
     or new.maximum_minor is distinct from old.maximum_minor
     or new.currency is distinct from old.currency
     or new.proposed_by_actor_id is distinct from old.proposed_by_actor_id
     or new.launch_delegation_id is distinct from old.launch_delegation_id
     or new.proposed_by_owner is distinct from old.proposed_by_owner
     or new.created_at is distinct from old.created_at then
    raise exception 'proposal_versions are immutable: version % cannot be edited', old.id
      using errcode = 'restrict_violation';
  end if;
  if old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at then
    raise exception 'version % is already superseded', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.proposal_versions_are_immutable() from public;
