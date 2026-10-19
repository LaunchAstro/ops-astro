-- SPDX-License-Identifier: AGPL-3.0-only
--
-- #1666: what an agent reply in a side chat opened on no task could edit.
--
-- When the server keeps an agent reply in a conversation with no task scope,
-- it writes one snapshot beside it, in the same transaction: how many tasks the
-- conversation had created by then (`created`), and, as targets, those of them
-- the asker could use, each with the task revision read. An edit card on that
-- reply may name only one of its targets, at that revision.
--
-- "Created by this conversation" is a fact of the task's creation audit event
-- (0093): an applied `task.create` in the same business whose
-- `origin_conversation_id` is the reply's conversation and whose
-- `subject_record_id` is the task. The guard below refuses a target the audit
-- chain does not show, a reply that is a person's message, and a reply in a
-- conversation opened on a task.
--
-- A snapshot is never changed: the application holds select and insert only.
-- It goes when its reply goes. The purge deletes a conversation's messages
-- (`purgeConversation`), and both tables cascade from `conversation_messages`,
-- so no delete grant is needed: Postgres runs a cascade as the table owner.
-- Nothing is backfilled; a reply kept before this migration has no snapshot.
--
-- Business-scoped with row-level security forced, one restrictive tenancy
-- policy and composite keys, as the rest of the schema is. The guard is
-- security invoker: it reads the message, its conversation and the audit chain
-- as the inserting role, through those tables' own tenancy policies (0007,
-- 0049), so it sees no other business's rows.

create table public.conversation_reply_snapshots (
  business_id uuid    not null,
  message_id  uuid    not null,
  created     integer not null,
  constraint conversation_reply_snapshots_pkey primary key (business_id, message_id),
  constraint conversation_reply_snapshots_message_fkey foreign key (business_id, message_id)
    references public.conversation_messages (business_id, id) on delete cascade,
  constraint conversation_reply_snapshots_created_positive check (created >= 1)
);

create table public.conversation_reply_targets (
  business_id uuid    not null,
  message_id  uuid    not null,
  position    integer not null,
  task_id     uuid    not null,
  revision    bigint  not null,
  constraint conversation_reply_targets_pkey primary key (business_id, message_id, position),
  constraint conversation_reply_targets_task_once unique (business_id, message_id, task_id),
  constraint conversation_reply_targets_snapshot_fkey foreign key (business_id, message_id)
    references public.conversation_reply_snapshots (business_id, message_id) on delete cascade,
  constraint conversation_reply_targets_task_fkey foreign key (business_id, task_id)
    references public.records (business_id, id) on delete cascade,
  constraint conversation_reply_targets_position_positive check (position >= 1),
  constraint conversation_reply_targets_revision_not_negative check (revision >= 0)
);

-- The task's own cascade from `records` finds its targets by this index.
create index conversation_reply_targets_task_idx
  on public.conversation_reply_targets (business_id, task_id);

alter table public.conversation_reply_snapshots enable row level security;
alter table public.conversation_reply_snapshots force row level security;
alter table public.conversation_reply_targets enable row level security;
alter table public.conversation_reply_targets force row level security;

create policy tenancy_conversation_reply_snapshots on public.conversation_reply_snapshots
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_conversation_reply_snapshots on public.conversation_reply_snapshots
  as permissive for all using (true) with check (true);

create policy tenancy_conversation_reply_targets on public.conversation_reply_targets
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_conversation_reply_targets on public.conversation_reply_targets
  as permissive for all using (true) with check (true);

-- A snapshot or target belongs to an agent reply of this business in a
-- conversation opened on no task; a target names a task that conversation's
-- own applied `task.create` made. Invoker rights: every read goes through the
-- caller's tenancy policy, so another business's message, conversation or
-- audit event is not there to find. Raised as check_violation, one message
-- per reason.
create function public.conversation_reply_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
  as $$
declare
  reply record;
begin
  select m.conversation_id, m.role, c.scope_record_id
    into reply
    from public.conversation_messages m
    join public.conversations c
      on c.business_id = m.business_id and c.id = m.conversation_id
   where m.business_id = new.business_id and m.id = new.message_id;
  if not found then
    raise exception 'REPLY_MESSAGE_ABSENT: %: message % is not a message of this business',
      tg_table_name, new.message_id
      using errcode = 'check_violation';
  end if;
  if reply.role <> 'agent' then
    raise exception 'REPLY_NOT_AGENT: %: message % is a person''s message, not an agent reply',
      tg_table_name, new.message_id
      using errcode = 'check_violation';
  end if;
  if reply.scope_record_id is not null then
    raise exception 'REPLY_CONVERSATION_SCOPED: %: message % is in a conversation opened on a task',
      tg_table_name, new.message_id
      using errcode = 'check_violation';
  end if;
  -- A snapshot row has no task; only a target's statement names one.
  if tg_table_name = 'conversation_reply_targets' then
    if not exists (
      select 1 from public.audit_events a
       where a.business_id = new.business_id
         and a.subject_record_id = new.task_id
         and a.command = 'task.create'
         and a.outcome = 'applied'
         and a.origin_conversation_id = reply.conversation_id
    ) then
      raise exception 'TARGET_NOT_CREATED_HERE: %: task % was not created by conversation %',
        tg_table_name, new.task_id, reply.conversation_id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.conversation_reply_guard() from public;

create trigger conversation_reply_snapshots_guard
  before insert on public.conversation_reply_snapshots
  for each row execute function public.conversation_reply_guard();

create trigger conversation_reply_targets_guard
  before insert on public.conversation_reply_targets
  for each row execute function public.conversation_reply_guard();

grant select, insert on public.conversation_reply_snapshots to ops_astro_app;
grant select, insert on public.conversation_reply_targets to ops_astro_app;
