-- SPDX-License-Identifier: AGPL-3.0-only
--
-- An agent is a member of a person's conversation, the way a person is a
-- member of a team conversation (#1531, live chat route B).
--
-- The model agent on the owner's machine hears a call only from a
-- conversation it is an open member of, judged where the call is offered and
-- where it is sent. The owner adds it, in their own session, by choosing a
-- model it carries (`conversation-agents.ts`); it leaves when another model is
-- chosen, when the conversation's body is purged, and when the agent is
-- deactivated. A membership is a row with when it opened and when it closed:
-- closing marks it, nothing deletes it, and a second joining is a second row.
--
-- Held by storage, whoever writes:
-- * the member is an agent of this business, active when its row opens, and
--   its actor row is held for share while that is asked, so a deactivation
--   either commits first (the row is refused) or waits and then closes it;
-- * at most one open row per conversation and agent;
-- * a conversation whose body is purged takes no open row;
-- * a closed row stays closed, and nothing else on a row changes;
-- * a deactivated agent's open rows close, and a purged conversation's do.
--
-- Team conversations still take no agent: this table names `conversations`,
-- the person's own, and `team_conversation_members` names people only.

create table public.conversation_agent_members (
  business_id       uuid        not null,
  id                uuid        not null default gen_random_uuid(),
  conversation_id   uuid        not null,
  agent_actor_id    uuid        not null,
  added_by_actor_id uuid        not null,
  joined_at         timestamptz not null default clock_timestamp(),
  left_at           timestamptz,
  constraint conversation_agent_members_pkey primary key (id),
  constraint conversation_agent_members_tenant_id_key unique (business_id, id),
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

-- An open row is an active agent's, on a conversation not purged. Both rows
-- are read for share, so a deactivation or a purge running now orders
-- against this write instead of passing it.
create function public.conversation_agent_members_open_is_an_agents() returns trigger
  language plpgsql
  as $$
begin
  if new.left_at is not null then
    return new;
  end if;
  if not exists (
    select 1 from public.actors a
     where a.business_id = new.business_id and a.id = new.agent_actor_id
       and a.kind = 'agent' and a.active
       for share
  ) then
    raise exception 'conversation_agent_members: % is not an active agent of this business',
      new.agent_actor_id
      using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.conversations c
     where c.business_id = new.business_id and c.id = new.conversation_id
       and c.body_purged_at is null
       for share
  ) then
    raise exception 'conversation_agent_members: conversation % is purged', new.conversation_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.conversation_agent_members_open_is_an_agents() from public;

create trigger conversation_agent_members_open_is_an_agents
  before insert on public.conversation_agent_members
  for each row execute function public.conversation_agent_members_open_is_an_agents();

-- A row closes once and otherwise never changes.
create function public.conversation_agent_members_close_once() returns trigger
  language plpgsql
  as $$
begin
  if (new.business_id, new.id, new.conversation_id, new.agent_actor_id, new.added_by_actor_id,
      new.joined_at)
     is distinct from
     (old.business_id, old.id, old.conversation_id, old.agent_actor_id, old.added_by_actor_id,
      old.joined_at)
     or old.left_at is not null and new.left_at is distinct from old.left_at
     or new.left_at is null and old.left_at is null
  then
    raise exception 'conversation_agent_members: a membership only closes, once'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.conversation_agent_members_close_once() from public;

create trigger conversation_agent_members_close_once
  before update on public.conversation_agent_members
  for each row execute function public.conversation_agent_members_close_once();

-- A deactivated agent's open rows close, and a purged conversation's. Definer
-- and row security off, so the close reaches the rows whichever role and
-- business setting made the change; it touches only the changed row's own.
create function public.conversation_agent_members_close_on_deactivation() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
  set row_security = off
  as $$
begin
  update public.conversation_agent_members
     set left_at = greatest(clock_timestamp(), joined_at)
   where business_id = new.business_id and agent_actor_id = new.id and left_at is null;
  return null;
end;
$$;

revoke execute on function public.conversation_agent_members_close_on_deactivation() from public;

create trigger conversation_agent_members_close_on_deactivation
  after update of active on public.actors
  for each row
  when (old.active and not new.active and new.kind = 'agent')
  execute function public.conversation_agent_members_close_on_deactivation();

create function public.conversation_agent_members_close_on_purge() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
  set row_security = off
  as $$
begin
  update public.conversation_agent_members
     set left_at = greatest(clock_timestamp(), joined_at)
   where business_id = new.business_id and conversation_id = new.id and left_at is null;
  return null;
end;
$$;

revoke execute on function public.conversation_agent_members_close_on_purge() from public;

create trigger conversation_agent_members_close_on_purge
  after update of body_purged_at on public.conversations
  for each row
  when (old.body_purged_at is null and new.body_purged_at is not null)
  execute function public.conversation_agent_members_close_on_purge();

alter table public.conversation_agent_members enable row level security;
alter table public.conversation_agent_members force row level security;

create policy tenancy_conversation_agent_members on public.conversation_agent_members
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_conversation_agent_members on public.conversation_agent_members
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert on public.conversation_agent_members to ops_astro_app;
grant update (left_at) on public.conversation_agent_members to ops_astro_app;
