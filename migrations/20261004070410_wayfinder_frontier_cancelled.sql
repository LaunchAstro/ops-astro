-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 20261004070410 WF-1: the frontier leaves out a cancelled ticket as it does a
-- completed one, and a cancelled blocker no longer holds a ticket back. Only
-- the frontier's two state tests change; the summary counts, the definer, the
-- search path, the per-map advisory lock and the revoke are 20261003001618's.

-- Recount one map, or drop its row when the id is no longer a live map.
-- Security definer so the read model has one writer; it runs under the
-- caller's business setting, which the forced tenancy policy still applies.
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
