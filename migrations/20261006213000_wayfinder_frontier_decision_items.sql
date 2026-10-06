-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 20261006213000 WF-2 (#673): a grilling or prototype ticket on its map's
-- frontier owes the map's owner one decision item, whichever write put it
-- there. The frontier is rewritten by the wayfinder maps migration's triggers
-- on every write to a map's tickets, links and parts, so a blocker completed
-- by anyone, an assignee or delegate cleared, a blocker deleted, a ticket
-- reopened or placed, all move it. The four wayfinder commands that raised
-- the item themselves are no longer its writer: this trigger is.
--
-- A deferred constraint trigger, so it answers for the frontier the
-- transaction commits. Every refresh deletes a map's frontier rows and
-- inserts new ones, and a chart files its tickets before it links their
-- blocking, so a ticket can cross the frontier and leave it again in one
-- transaction. At commit each inserted row is raised only while it still
-- exists; a row a later refresh replaced has gone.
--
-- Once per ticket and owner: an item already raised, open or cleared, is not
-- raised again. The owner is the map's `map_owner` joined by text to a person
-- of the same business, so an owner that is no person here, or no uuid at
-- all, raises nothing and never fails the commit. Only grilling and prototype
-- tickets owe a decision; research, task and build tickets owe nobody one.
--
-- It runs as the map read models' role (20261006181500), as its siblings do,
-- so the made-up guard and row security judge its inserts as the
-- application's. The role gains reads of people and inbox_items and inserts
-- to inbox_items, nothing more. Every statement carries the tenancy test.

grant select on public.people to ops_astro_map_path;
grant select, insert on public.inbox_items to ops_astro_map_path;

create or replace function public.map_frontier_raise_decision()
  returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
declare
  v_business uuid := public.app_business_id();
begin
  if new.business_id is distinct from v_business then return null; end if;
  insert into public.inbox_items
    (business_id, id, recipient_person_id, subject_record_id, reason, fact_kind, fact_id, owed)
  select v_business, gen_random_uuid(), p.id, t.id, 'decision', 'record', t.id, true
    from public.map_frontier f
    join public.records t on t.business_id = f.business_id and t.id = f.ticket_id
    join public.records m on m.business_id = f.business_id and m.id = f.map_id
    join public.people p
      on p.business_id = f.business_id and p.id::text = m.data ->> 'map_owner'
   where f.business_id = v_business and f.id = new.id
     and t.deleted_at is null and t.data ->> 'type' in ('grilling', 'prototype')
     and not exists (
       select 1 from public.inbox_items i
        where i.business_id = v_business and i.recipient_person_id = p.id
          and i.subject_record_id = t.id and i.reason = 'decision'
          and i.fact_kind = 'record' and i.fact_id = t.id)
  on conflict (business_id, recipient_person_id, subject_record_id, reason, fact_kind, fact_id)
    where work_state = 'open' do nothing;
  return null;
end;
$$;

revoke all on function public.map_frontier_raise_decision() from public;

create constraint trigger map_frontier_decision_items
  after insert on public.map_frontier
  deferrable initially deferred
  for each row execute function public.map_frontier_raise_decision();

-- A new owner needs CREATE on its schema at the change, as 20261006181500 did.
grant create on schema public to ops_astro_map_path;
alter function public.map_frontier_raise_decision() owner to ops_astro_map_path;
revoke create on schema public from ops_astro_map_path;
revoke all on function public.map_frontier_raise_decision() from public;
