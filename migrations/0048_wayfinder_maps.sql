-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0048 wayfinder maps (WF-1). A map is a task of type `map` whose tickets are
-- its subtasks; there is no map record type and no maps table. What a map has
-- that a task does not is its body: typed components (Destination, Notes, fog
-- patches, Out of scope items), each with its own id, and a numbered version
-- per revision. Decisions so far is not stored here: it is rendered from the
-- map's resolved subtasks, so a decision lives once, on its ticket.
--
-- The summary read model (`map_summaries`) is written only by the triggers
-- below, in the transaction that changed what it counts, so a read after a
-- write never shows the old counts and no command path can forget it. The
-- application role may read it and nothing else.
--
-- Inherits 0001's four rules: `business_id` leading every key, row security
-- enabled and forced with the restrictive tenancy policy, composite foreign
-- keys, and an application role that owns nothing.

create table public.map_components (
  business_id      uuid        not null,
  id               uuid        not null,
  map_id           uuid        not null,
  kind             text        not null,
  body             text        not null,
  -- An Out of scope item's closed ticket, where one exists.
  ticket_id        uuid,
  position         integer     not null,
  created_version  integer     not null,
  -- The version that replaced or removed it; null while it is current.
  retired_version  integer,
  -- A graduated fog patch: the tickets it became (WF-2).
  graduated_into   uuid[],
  created_at       timestamptz not null default now(),
  constraint map_components_pkey primary key (id),
  constraint map_components_tenant_id_key unique (business_id, id),
  constraint map_components_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint map_components_map_fkey foreign key (business_id, map_id)
    references public.records (business_id, id) on delete cascade,
  constraint map_components_ticket_fkey foreign key (business_id, ticket_id)
    references public.records (business_id, id) on delete set null (ticket_id),
  constraint map_components_kind_known
    check (kind in ('destination', 'notes', 'fog', 'out_of_scope')),
  constraint map_components_body_bounded
    check (char_length(btrim(body)) between 1 and 4000),
  constraint map_components_ticket_only_out_of_scope
    check (ticket_id is null or kind = 'out_of_scope'),
  constraint map_components_graduated_fog
    check (graduated_into is null or (kind = 'fog' and retired_version is not null)),
  constraint map_components_versions_ordered
    check (created_version >= 1 and (retired_version is null or retired_version > created_version))
);

create index map_components_business_idx on public.map_components (business_id);
create index map_components_map_idx
  on public.map_components (business_id, map_id, kind, position)
  where retired_version is null;
-- One current Destination and one current Notes per map.
create unique index map_components_one_text_idx
  on public.map_components (business_id, map_id, kind)
  where retired_version is null and kind in ('destination', 'notes');
create index map_components_ticket_idx on public.map_components (business_id, ticket_id);

alter table public.map_components enable row level security;
alter table public.map_components force row level security;

create policy tenancy_map_components on public.map_components
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_map_components on public.map_components
  as permissive
  for all
  using (true)
  with check (true);

-- A component is retired by version, never deleted, so a version's history
-- stays readable. Delete is withheld; the cascade from a purged map is the
-- owner's foreign key, not the application's grant.
grant select, insert, update on public.map_components to ops_astro_app;

create table public.map_versions (
  business_id  uuid        not null,
  id           uuid        not null,
  map_id       uuid        not null,
  version      integer     not null,
  -- The components this version added or retired.
  changed      uuid[]      not null,
  actor_id     uuid        not null,
  created_at   timestamptz not null default now(),
  constraint map_versions_pkey primary key (id),
  constraint map_versions_tenant_id_key unique (business_id, id),
  constraint map_versions_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint map_versions_map_fkey foreign key (business_id, map_id)
    references public.records (business_id, id) on delete cascade,
  constraint map_versions_actor_fkey foreign key (business_id, actor_id)
    references public.actors (business_id, id),
  constraint map_versions_numbered check (version >= 1),
  constraint map_versions_changed_something check (cardinality(changed) >= 1)
);

create unique index map_versions_number_idx on public.map_versions (business_id, map_id, version);
create index map_versions_business_idx on public.map_versions (business_id);

alter table public.map_versions enable row level security;
alter table public.map_versions force row level security;

create policy tenancy_map_versions on public.map_versions
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_map_versions on public.map_versions
  as permissive
  for all
  using (true)
  with check (true);

-- Append only: a version is history.
grant select, insert on public.map_versions to ops_astro_app;

create table public.map_summaries (
  business_id     uuid        not null,
  id              uuid        not null,
  map_id          uuid        not null,
  version         integer     not null,
  open_tickets    integer     not null,
  closed_tickets  integer     not null,
  fog             integer     not null,
  out_of_scope    integer     not null,
  updated_at      timestamptz not null default now(),
  constraint map_summaries_pkey primary key (id),
  constraint map_summaries_tenant_id_key unique (business_id, id),
  constraint map_summaries_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint map_summaries_map_fkey foreign key (business_id, map_id)
    references public.records (business_id, id) on delete cascade,
  constraint map_summaries_counts_whole
    check (version >= 0 and open_tickets >= 0 and closed_tickets >= 0
           and fog >= 0 and out_of_scope >= 0)
);

create unique index map_summaries_map_idx on public.map_summaries (business_id, map_id);
create index map_summaries_business_idx on public.map_summaries (business_id);

alter table public.map_summaries enable row level security;
alter table public.map_summaries force row level security;

create policy tenancy_map_summaries on public.map_summaries
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_map_summaries on public.map_summaries
  as permissive
  for all
  using (true)
  with check (true);

grant select on public.map_summaries to ops_astro_app;

-- The frontier read model (WF-2): a map's open, unblocked, unclaimed tickets
-- in order. Written with the summary, by the same function, so the two never
-- disagree about a map.
create table public.map_frontier (
  business_id  uuid     not null,
  id           uuid     not null,
  map_id       uuid     not null,
  ticket_id    uuid     not null,
  position     integer  not null,
  constraint map_frontier_pkey primary key (id),
  constraint map_frontier_tenant_id_key unique (business_id, id),
  constraint map_frontier_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint map_frontier_map_fkey foreign key (business_id, map_id)
    references public.records (business_id, id) on delete cascade,
  constraint map_frontier_ticket_fkey foreign key (business_id, ticket_id)
    references public.records (business_id, id) on delete cascade,
  constraint map_frontier_position_counts check (position >= 1)
);

create unique index map_frontier_ticket_idx on public.map_frontier (business_id, map_id, ticket_id);
create index map_frontier_order_idx on public.map_frontier (business_id, map_id, position);
create index map_frontier_business_idx on public.map_frontier (business_id);
create index map_frontier_ticket_fk_idx on public.map_frontier (business_id, ticket_id);

alter table public.map_frontier enable row level security;
alter table public.map_frontier force row level security;

create policy tenancy_map_frontier on public.map_frontier
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_map_frontier on public.map_frontier
  as permissive
  for all
  using (true)
  with check (true);

grant select on public.map_frontier to ops_astro_app;

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
     and s.data ->> 'machine_category' is distinct from 'completed'
     and c.uuid_2 is null and c.uuid_3 is null
     and not exists (
       select 1 from public.record_links l
         join public.records b on b.business_id = l.business_id and b.id = l.from_record_id
         left join public.records bs on bs.business_id = b.business_id and bs.id = b.uuid_1
        where l.business_id = v_business and l.link_type = 'blocks' and l.to_record_id = c.id
          and b.deleted_at is null
          and bs.data ->> 'machine_category' is distinct from 'completed');

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

-- A record write touches at most four maps: itself, and its parent before
-- and after. Each candidate that is not a live map is a no-op in the refresh.
create or replace function public.map_summary_on_record()
  returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
declare
  v_map uuid;
begin
  for v_map in
    select distinct m from unnest(array[
      case when tg_op <> 'DELETE' then new.id end,
      case when tg_op <> 'DELETE' then new.uuid_4 end,
      case when tg_op <> 'INSERT' then old.id end,
      case when tg_op <> 'INSERT' then old.uuid_4 end
    ]) as m where m is not null
  loop
    perform public.map_summary_refresh(v_map);
  end loop;
  return null;
end;
$$;

revoke all on function public.map_summary_on_record() from public;

create trigger records_map_summary
  after insert or update or delete on public.records
  for each row execute function public.map_summary_on_record();

create or replace function public.map_summary_on_map_part()
  returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.map_summary_refresh(old.map_id);
  else
    perform public.map_summary_refresh(new.map_id);
  end if;
  return null;
end;
$$;

revoke all on function public.map_summary_on_map_part() from public;

create trigger map_components_map_summary
  after insert or update or delete on public.map_components
  for each row execute function public.map_summary_on_map_part();

create trigger map_versions_map_summary
  after insert on public.map_versions
  for each row execute function public.map_summary_on_map_part();

-- A blocking link moves the frontier of the map its tickets are filed under.
create or replace function public.map_summary_on_link()
  returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
declare
  v_map uuid;
begin
  for v_map in
    select distinct r.uuid_4 from public.records r
     where r.business_id = public.app_business_id() and r.uuid_4 is not null
       and r.id in (
         case when tg_op <> 'DELETE' then new.to_record_id end,
         case when tg_op <> 'INSERT' then old.to_record_id end)
  loop
    perform public.map_summary_refresh(v_map);
  end loop;
  return null;
end;
$$;

revoke all on function public.map_summary_on_link() from public;

create trigger record_links_map_summary
  after insert or update or delete on public.record_links
  for each row execute function public.map_summary_on_link();
