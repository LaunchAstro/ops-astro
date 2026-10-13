-- SPDX-License-Identifier: AGPL-3.0-only
--
-- An agent is a member of a person's conversation (#1531, live chat route B):
-- the model agent hears a call only from a conversation it is an open member
-- of (`conversation-agents.ts` adds it). Storage holds: an open row is an
-- active agent's on an unpurged conversation, both read for share; one open
-- row per conversation and agent; a row only closes, once; a deactivation, a
-- purge or a client linked to the conversation's task closes the open rows.

create table public.conversation_agent_members (
  business_id       uuid        not null,
  id                uuid        not null default gen_random_uuid(),
  conversation_id   uuid        not null,
  agent_actor_id    uuid        not null,
  added_by_actor_id uuid        not null,
  joined_at         timestamptz not null default clock_timestamp(),
  left_at           timestamptz,
  constraint conversation_agent_members_pkey primary key (id),
  constraint conversation_agent_members_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint conversation_agent_members_conversation_fkey foreign key (business_id, conversation_id)
    references public.conversations (business_id, id),
  constraint conversation_agent_members_agent_fkey foreign key (business_id, agent_actor_id)
    references public.actors (business_id, id),
  constraint conversation_agent_members_added_by_fkey foreign key (business_id, added_by_actor_id)
    references public.actors (business_id, id),
  constraint conversation_agent_members_left check (left_at is null or left_at >= joined_at)
);

create unique index conversation_agent_members_one_open_idx
  on public.conversation_agent_members (business_id, conversation_id, agent_actor_id)
  where left_at is null;

create index conversation_agent_members_agent_idx
  on public.conversation_agent_members (business_id, agent_actor_id)
  where left_at is null;

create function public.conversation_agent_members_guard() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'UPDATE' then
    if (new.business_id, new.id, new.conversation_id, new.agent_actor_id, new.added_by_actor_id,
        new.joined_at) is distinct from (old.business_id, old.id, old.conversation_id,
        old.agent_actor_id, old.added_by_actor_id, old.joined_at)
       or old.left_at is not null and new.left_at is distinct from old.left_at then
      raise exception 'conversation_agent_members: a membership only closes, once'
        using errcode = 'check_violation';
    end if;
  elsif new.left_at is null and (
    not exists (select 1 from public.actors a
                 where a.business_id = new.business_id and a.id = new.agent_actor_id
                   and a.kind = 'agent' and a.active
                   for share)
    or not exists (select 1 from public.conversations c
                    where c.business_id = new.business_id and c.id = new.conversation_id
                      and c.body_purged_at is null
                      for share)) then
    raise exception 'conversation_agent_members: an open row is an active agent''s, unpurged'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.conversation_agent_members_guard() from public;

create trigger conversation_agent_members_guard
  before insert or update on public.conversation_agent_members
  for each row execute function public.conversation_agent_members_guard();

-- Definer, row security off: it reaches only the changed row's own memberships.
create function public.conversation_agent_members_close() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
  set row_security = off
  as $$
begin
  -- Locked first, so `left_at` is read after any wait on them.
  with closing as (
    select m.id from public.conversation_agent_members m
     where m.business_id = new.business_id and m.left_at is null
       and case tg_table_name
             when 'actors' then m.agent_actor_id = new.id
             when 'conversations' then m.conversation_id = new.id
             else m.conversation_id in (
               select c.id from public.conversations c
                where c.business_id = new.business_id and c.scope_record_id = new.id)
           end
     for update)
  update public.conversation_agent_members m
     set left_at = greatest(clock_timestamp(), m.joined_at)
    from closing where m.id = closing.id;
  return null;
end;
$$;

revoke execute on function public.conversation_agent_members_close() from public;

create trigger conversation_agent_members_close_on_deactivation
  after update of active on public.actors
  for each row when (old.active and not new.active and new.kind = 'agent')
  execute function public.conversation_agent_members_close();

create trigger conversation_agent_members_close_on_purge
  after update of body_purged_at on public.conversations
  for each row when (old.body_purged_at is null and new.body_purged_at is not null)
  execute function public.conversation_agent_members_close();

-- A task's client link is `records.uuid_7` (0055), written through `data`, so the
-- trigger watches every update and compares the column.
create trigger conversation_agent_members_close_on_client_link
  after update on public.records
  for each row when (new.uuid_7 is not null and old.uuid_7 is distinct from new.uuid_7)
  execute function public.conversation_agent_members_close();

alter table public.conversation_agent_members enable row level security;
alter table public.conversation_agent_members force row level security;

create policy tenancy_conversation_agent_members on public.conversation_agent_members
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_conversation_agent_members on public.conversation_agent_members
  as permissive for all using (true) with check (true);

grant select, insert on public.conversation_agent_members to ops_astro_app;
grant update (left_at) on public.conversation_agent_members to ops_astro_app;
