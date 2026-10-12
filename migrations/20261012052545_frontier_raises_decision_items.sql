-- SPDX-License-Identifier: AGPL-3.0-only
--
-- WF-2's decision item on every frontier move (MP-7-3). A grilling or
-- prototype ticket on its map's frontier owes the map's owner a decision. The
-- frontier is rewritten by `map_summary_refresh` on every record, link and map
-- part write, so a generic task write (a blocker completed, reopened, trashed
-- or restored) moves it as the wayfinder commands do, but only those commands
-- raised the item (`wayfinder-frontier-raise.ts`). Raised here as each
-- frontier row lands, every writer raises it, today's and later ones.
--
-- At commit, not as the row lands: one command rewrites the frontier several
-- times (a chart files a ticket before the link that blocks it), so a row only
-- raises if it is still on the frontier when its transaction commits, which is
-- the frontier the command layer's raise reads after its write.
--
-- The same rule as the command layer's raise: once per ticket and owner, an
-- item already raised, open or cleared, is not raised again; only the map's
-- owner; only grilling and prototype tickets; and only in the frontier row's
-- own business, which every statement here names. Whichever role commits,
-- it runs as the map read models' role, the frontier's one writer (security
-- definer, 20261006181500), under row security, which holds it to the
-- transaction's business as well; that role now reads and inserts inbox items.

create function public.map_frontier_raise_decision()
  returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1 from public.map_frontier f where f.business_id = new.business_id and f.id = new.id
  ) then
    return null;
  end if;
  insert into public.inbox_items
    (business_id, id, recipient_person_id, subject_record_id, reason, fact_kind, fact_id, owed,
     raised_at)
  select new.business_id, gen_random_uuid(), (m.data ->> 'map_owner')::uuid, new.ticket_id,
         'decision', 'record', new.ticket_id, true, now()
    from public.records m
    join public.records t on t.business_id = new.business_id and t.id = new.ticket_id
   where m.business_id = new.business_id and m.id = new.map_id
     and m.data ->> 'map_owner' is not null
     and t.data ->> 'type' in ('grilling', 'prototype')
     and not exists (
       select 1 from public.inbox_items i
        where i.business_id = new.business_id
          and i.recipient_person_id = (m.data ->> 'map_owner')::uuid
          and i.subject_record_id = new.ticket_id and i.reason = 'decision'
          and i.fact_kind = 'record' and i.fact_id = new.ticket_id)
  on conflict (business_id, recipient_person_id, subject_record_id, reason, fact_kind, fact_id)
    where work_state = 'open' do nothing;
  return null;
end;
$$;

revoke all on function public.map_frontier_raise_decision() from public;

grant select, insert on public.inbox_items to ops_astro_map_path;
-- A new owner needs CREATE on its schema at the change, held for it alone.
grant create on schema public to ops_astro_map_path;
alter function public.map_frontier_raise_decision() owner to ops_astro_map_path;
revoke create on schema public from ops_astro_map_path;

create constraint trigger map_frontier_raises_decision
  after insert on public.map_frontier
  deferrable initially deferred
  for each row execute function public.map_frontier_raise_decision();
