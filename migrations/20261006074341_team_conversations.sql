-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 20261004091439 team conversations (C71-D, CS-7.25, CS-7.26; C71-G builds on it).
--
-- A conversation is a record of its own type, `team_conversation`, and its
-- messages are comments on the one comment record (`task_comment`) anchored to
-- it by the comment's `conversation` field instead of a task (RA-12): no other
-- table holds a message body. What cannot be a record field is here: who is a
-- member and from when to when, and each member's own read marker. The record
-- type and its field rows are written by `installTaskSpine` for a new business
-- (`packages/core-records/src/team/conversations.ts`); this migration writes
-- them for the businesses installed before it.

-- ---------------------------------------------------------------------------
-- The conversation type and the comment's anchor, on every installed business.
-- ---------------------------------------------------------------------------

insert into public.record_types (business_id, id, key, name, origin, retention_class)
select t.business_id, gen_random_uuid(), 'team_conversation', 'Team conversation', 'core', 'work'
  from public.record_types t
 where t.key = 'task_comment'
   and not exists (
     select 1 from public.record_types c
      where c.business_id = t.business_id and c.key = 'team_conversation'
   );

-- The rows `installTaskSpine` writes for a new business: four system fields,
-- prefixed because an installed system key is refused at the top level of every
-- request body, and `name` there is a tag's and a client's.
insert into public.field_defs
  (business_id, id, record_type_id, key, label, value_type, slot, write_mode,
   owning_operation, escalating_operation, visibility_class, searchable,
   unique_value, origin)
select t.business_id, gen_random_uuid(), t.id, f.key, f.label, f.value_type, f.slot, 'system',
       null, null, 'internal', false, false, 'core'
  from public.record_types t
 cross join (values
   ('chat_kind', 'Kind', 'text', 'txt_1'),
   ('chat_name', 'Name', 'text', 'txt_2'),
   ('chat_pair', 'Pair', 'text', 'txt_3'),
   ('chat_creator', 'Started by', 'uuid', 'uuid_1')
 ) as f (key, label, value_type, slot)
 where t.key = 'team_conversation'
   and not exists (
     select 1 from public.field_defs d
      where d.business_id = t.business_id and d.record_type_id = t.id and d.key = f.key
   );

-- `uuid_4` and the key `conversation` were free on the comment type; a preset
-- field already holding either is not the core's to move, so this refuses.
do $$
declare
  held record;
begin
  select f.business_id, f.key, f.slot
    into held
    from public.field_defs f
    join public.record_types t on t.business_id = f.business_id and t.id = f.record_type_id
   where t.key = 'task_comment' and f.origin <> 'core'
     and (f.slot = 'uuid_4' or f.key = 'conversation')
   limit 1;
  if found then
    raise exception 'field_defs: comment field % holds %, which conversations reserve (business %)',
      held.key, held.slot, held.business_id
      using errcode = 'check_violation';
  end if;
end;
$$;

insert into public.field_defs
  (business_id, id, record_type_id, key, label, value_type, slot, write_mode,
   owning_operation, escalating_operation, visibility_class, searchable,
   unique_value, origin)
select t.business_id, gen_random_uuid(), t.id, 'conversation', 'Conversation', 'uuid', 'uuid_4',
       'system', null, null, 'internal', false, false, 'core'
  from public.record_types t
 where t.key = 'task_comment'
   and not exists (
     select 1 from public.field_defs f
      where f.business_id = t.business_id and f.record_type_id = t.id and f.key = 'conversation'
   );

-- ---------------------------------------------------------------------------
-- Members, each with when they joined and left, and their own read marker.
-- ---------------------------------------------------------------------------

-- Staff only, by the command that adds them: a client and an agent are never a
-- member (`people`, not `actors`). `left_at` is C71-G's; a member reads
-- nothing written after it. `last_read_at` is set by its own person alone and
-- is not audited (CS-7.25); unread is derived from it at read time.
create table public.team_conversation_members (
  business_id     uuid        not null,
  conversation_id uuid        not null,
  person_id       uuid        not null,
  joined_at       timestamptz not null default now(),
  left_at         timestamptz,
  last_read_at    timestamptz,
  constraint team_conversation_members_pkey primary key (business_id, conversation_id, person_id),
  constraint team_conversation_members_conversation_fkey foreign key (business_id, conversation_id)
    references public.records (business_id, id),
  constraint team_conversation_members_person_fkey foreign key (business_id, person_id)
    references public.people (business_id, id),
  constraint team_conversation_members_left check (left_at is null or left_at >= joined_at)
);

create index team_conversation_members_person_idx
  on public.team_conversation_members (business_id, person_id);

alter table public.team_conversation_members enable row level security;
alter table public.team_conversation_members force row level security;

create policy tenancy_team_conversation_members on public.team_conversation_members
  as restrictive
  for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_team_conversation_members on public.team_conversation_members
  as permissive
  for all
  using (true)
  with check (true);

grant select, insert, update on public.team_conversation_members to ops_astro_app;
