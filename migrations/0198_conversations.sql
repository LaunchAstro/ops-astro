-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0198 the conversation outlives its body (AW-03).
--
-- Three records. A conversation: its owner, its scope and subject, when it
-- was last active and when its body was purged. Its messages: the body,
-- append only (there is no edit operation), removed only by the purge. Its
-- wrap-ups: what the conversation asked, created, cost and left open, written
-- from records at quiet, versioned, and never purged, so the conversation's
-- address answers after the body has gone.
--
-- Origin-conversation references sit on runs and gate instances, which the
-- wrap-up reads as pointers. The task carries no conversation column: which
-- conversation created a task is a fact of the task's creation audit event.
--
-- The window is `conversation_window_days`, already a business setting
-- (0009); the purge reads it and applies the floor and the ceiling.
--
-- Every table is business-scoped with row-level security forced, one
-- restrictive business-scoping policy and composite keys, as the rest of the
-- schema is. No security-definer function is added: the triggers only raise
-- or read rows the caller's own policy lets it read.

create table public.conversations (
  business_id        uuid        not null,
  id                 uuid        not null,
  owner_actor_id     uuid        not null,
  owner_person_id    uuid        not null,
  title              text        not null,
  subject            text,
  -- The scope the drawer was opened on. A second citation replaces the first,
  -- so it is one pair, not a list. A task is the only kind this build names.
  scope_kind         text,
  scope_record_id    uuid,
  created_at         timestamptz not null default now(),
  last_activity_at   timestamptz not null default now(),
  body_purged_at     timestamptz,
  purge_operation_id text,
  constraint conversations_pkey primary key (id),
  constraint conversations_tenant_id_key unique (business_id, id),
  constraint conversations_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint conversations_owner_actor_fkey foreign key (business_id, owner_actor_id)
    references public.actors (business_id, id),
  constraint conversations_owner_person_fkey foreign key (business_id, owner_person_id)
    references public.people (business_id, id),
  constraint conversations_scope_record_fkey foreign key (business_id, scope_record_id)
    references public.records (business_id, id),
  constraint conversations_scope_kind_known check (scope_kind is null or scope_kind = 'task'),
  constraint conversations_scope_pair check ((scope_kind is null) = (scope_record_id is null)),
  constraint conversations_title_bounded check (char_length(btrim(title)) between 1 and 120),
  constraint conversations_subject_bounded
    check (subject is null or char_length(btrim(subject)) between 1 and 200),
  constraint conversations_purge_pair
    check ((body_purged_at is null) = (purge_operation_id is null)),
  constraint conversations_activity_after_creation check (last_activity_at >= created_at)
);

create index conversations_business_idx on public.conversations (business_id);
create index conversations_owner_idx on public.conversations (business_id, owner_actor_id);
create index conversations_quiet_idx
  on public.conversations (business_id, last_activity_at)
  where body_purged_at is null;

create table public.conversation_messages (
  business_id      uuid        not null,
  id               uuid        not null,
  conversation_id  uuid        not null,
  role             text        not null,
  author_actor_id  uuid        not null,
  body             text        not null,
  created_at       timestamptz not null default now(),
  constraint conversation_messages_pkey primary key (id),
  constraint conversation_messages_tenant_id_key unique (business_id, id),
  constraint conversation_messages_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint conversation_messages_conversation_fkey foreign key (business_id, conversation_id)
    references public.conversations (business_id, id),
  constraint conversation_messages_author_fkey foreign key (business_id, author_actor_id)
    references public.actors (business_id, id),
  constraint conversation_messages_role_known check (role in ('person', 'agent')),
  constraint conversation_messages_body_bounded check (char_length(body) between 1 and 20000)
);

create index conversation_messages_business_idx on public.conversation_messages (business_id);
create index conversation_messages_conversation_idx
  on public.conversation_messages (business_id, conversation_id, created_at);

create table public.conversation_wrap_ups (
  business_id          uuid        not null,
  id                   uuid        not null,
  conversation_id      uuid        not null,
  version              integer     not null,
  -- The writer: the operation and the code revision it ran; a definition
  -- version once the definitions module exists.
  written_by_operation text        not null,
  code_revision        text        not null,
  definition_version   text,
  -- The first message, as a marked quotation. Never a transcript.
  request_quotation    text        not null,
  -- The seven pointer-and-fact contents, each `{key, fact, pointers}`.
  items                jsonb       not null,
  -- Item 8: what was left open, as pointers; an empty array is "nothing left
  -- open". Not null: a wrap-up without item 8 does not exist (owner, U5).
  left_open            jsonb       not null,
  -- The last activity this version covers. A later message makes a later
  -- version due; the same activity never writes a second one.
  activity_through     timestamptz not null,
  created_at           timestamptz not null default now(),
  constraint conversation_wrap_ups_pkey primary key (id),
  constraint conversation_wrap_ups_tenant_id_key unique (business_id, id),
  constraint conversation_wrap_ups_version_key unique (business_id, conversation_id, version),
  constraint conversation_wrap_ups_activity_key
    unique (business_id, conversation_id, activity_through),
  constraint conversation_wrap_ups_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint conversation_wrap_ups_conversation_fkey foreign key (business_id, conversation_id)
    references public.conversations (business_id, id),
  constraint conversation_wrap_ups_version_positive check (version >= 1),
  constraint conversation_wrap_ups_operation_named
    check (written_by_operation ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint conversation_wrap_ups_revision_present check (char_length(btrim(code_revision)) > 0),
  constraint conversation_wrap_ups_items_array
    check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) = 7),
  constraint conversation_wrap_ups_left_open_array check (jsonb_typeof(left_open) = 'array')
);

create index conversation_wrap_ups_business_idx on public.conversation_wrap_ups (business_id);

-- Origin references: the run or gate a conversation started.
alter table public.planned_runs add column origin_conversation_id uuid;
alter table public.planned_runs
  add constraint planned_runs_origin_conversation_fkey
  foreign key (business_id, origin_conversation_id)
  references public.conversations (business_id, id);

alter table public.gates add column origin_conversation_id uuid;
alter table public.gates
  add constraint gates_origin_conversation_fkey
  foreign key (business_id, origin_conversation_id)
  references public.conversations (business_id, id);

create index planned_runs_origin_conversation_idx
  on public.planned_runs (business_id, origin_conversation_id)
  where origin_conversation_id is not null;
create index gates_origin_conversation_idx
  on public.gates (business_id, origin_conversation_id)
  where origin_conversation_id is not null;

-- Row-level security: one restrictive business policy and a permissive one,
-- as every tenant table has.
alter table public.conversations enable row level security;
alter table public.conversations force row level security;
alter table public.conversation_messages enable row level security;
alter table public.conversation_messages force row level security;
alter table public.conversation_wrap_ups enable row level security;
alter table public.conversation_wrap_ups force row level security;

create policy tenancy_conversations on public.conversations
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_conversations on public.conversations
  as permissive for all using (true) with check (true);

create policy tenancy_conversation_messages on public.conversation_messages
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_conversation_messages on public.conversation_messages
  as permissive for all using (true) with check (true);

create policy tenancy_conversation_wrap_ups on public.conversation_wrap_ups
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_conversation_wrap_ups on public.conversation_wrap_ups
  as permissive for all using (true) with check (true);

-- A message is never edited. It is deleted only by the purge, and only once
-- its conversation holds a wrap-up (which always carries item 8): the
-- database refuses a purge without one whatever the calling code does.
create or replace function public.conversation_messages_guard()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'conversation_messages has no edit: message % cannot be updated', old.id;
  end if;
  if not exists (
    select 1 from public.conversation_wrap_ups w
     where w.business_id = old.business_id and w.conversation_id = old.conversation_id
  ) then
    raise exception 'WRAP_UP_ABSENT: conversation % has no wrap-up', old.conversation_id;
  end if;
  return old;
end;
$$;

revoke all on function public.conversation_messages_guard() from public;

create trigger conversation_messages_guard
  before update or delete on public.conversation_messages
  for each row execute function public.conversation_messages_guard();

-- A wrap-up is never changed and never purged.
create or replace function public.conversation_wrap_ups_append_only()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  raise exception 'conversation_wrap_ups is append only: wrap-up % cannot be %', old.id, lower(tg_op);
end;
$$;

revoke all on function public.conversation_wrap_ups_append_only() from public;

create trigger conversation_wrap_ups_no_change
  before update or delete on public.conversation_wrap_ups
  for each row execute function public.conversation_wrap_ups_append_only();

grant select, insert, update on public.conversations to ops_astro_app;
grant select, insert, delete on public.conversation_messages to ops_astro_app;
grant select, insert on public.conversation_wrap_ups to ops_astro_app;
