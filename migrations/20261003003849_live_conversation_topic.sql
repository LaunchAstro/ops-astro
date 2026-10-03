-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 20261003003849 a team conversation's live topic (C71, CS-7.42).
--
-- A message in a conversation, and the conversation's own record, stamp its
-- topic in the live change record (0065) as a task's writes stamp a task's,
-- and notify `business:conversation:<id>` on the same channel: no second
-- transport. Who is in it moving (a member added, removed or leaving) does
-- too, so a stream that may no longer follow it is asked again at once. A
-- read marker moving does not: one member reading tells the others nothing.
-- The topic names the conversation alone; who may hear it is asked when it
-- is heard (`apps/api/live.ts`), its members only.

alter table public.live_changes drop constraint live_changes_kind;
alter table public.live_changes
  add constraint live_changes_kind check (subject_kind in ('task', 'conversation'));

create or replace function public.live_record_topics()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
declare
  topic record;
begin
  -- A task, or a record naming one in `data ->> 'task'` (a comment), is a task
  -- topic; a conversation, or a message (a comment naming one in
  -- `data ->> 'conversation'`, the one type 20261003000558 reserves that key on), a
  -- conversation topic; any other record stamps nothing. Each
  -- is stamped in kind and id order, so two bulk writes lock rows alike.
  for topic in
    select distinct changed.business_id, k.kind, lower(k.subject) as subject
      from changed
      join public.record_types t
        on t.business_id = changed.business_id and t.id = changed.record_type_id
     cross join lateral (
       select 'task' as kind, coalesce(changed.data ->> 'task', changed.id::text) as subject
        where changed.data ->> 'task' is not null or t.key = 'task'
       union all
       select 'conversation', coalesce(changed.data ->> 'conversation', changed.id::text)
        where (changed.data ->> 'conversation' is not null and t.key = 'task_comment')
           or t.key = 'team_conversation'
     ) as k
     order by 2, 3
  loop
    if topic.subject ~ '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' then
      insert into public.live_changes as c (business_id, subject_kind, subject_id)
           values (topic.business_id, topic.kind, topic.subject::uuid)
      on conflict (business_id, subject_kind, subject_id)
      do update set changed_xid = pg_current_xact_id(), changed_at = now()
            where c.changed_xid <> pg_current_xact_id();
    end if;
    perform pg_notify('ops_astro_live',
                      topic.business_id::text || ':' || topic.kind || ':' || topic.subject);
  end loop;
  return null;
end;
$$;

create or replace function public.live_conversation_members()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  insert into public.live_changes as c (business_id, subject_kind, subject_id)
       values (new.business_id, 'conversation', new.conversation_id)
  on conflict (business_id, subject_kind, subject_id)
  do update set changed_xid = pg_current_xact_id(), changed_at = now()
        where c.changed_xid <> pg_current_xact_id();
  perform pg_notify('ops_astro_live',
                    new.business_id::text || ':conversation:' || new.conversation_id::text);
  return null;
end;
$$;

revoke all on function public.live_conversation_members() from public;

create trigger team_conversation_members_live_insert
  after insert on public.team_conversation_members
  for each row execute function public.live_conversation_members();

create trigger team_conversation_members_live_update
  after update on public.team_conversation_members
  for each row
  when (old.joined_at is distinct from new.joined_at or old.left_at is distinct from new.left_at)
  execute function public.live_conversation_members();
