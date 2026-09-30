-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0044 replies and edits in a task conversation (MP-4-5, R42, CS-4.33, CS-4.34).
--
-- A reply names the top-level message it sits under, one level deep, in the
-- comment type's `parent` field, owned by `task.comment`; and a comment's
-- author rewrites its body through `task.edit_comment`
-- (`packages/core-records/src/tasks/comments.ts`). Like every comment field
-- these are metadata rows over fixed slots, not columns (ADR 0037). What
-- cannot be a row is here: the field rows for the comment types installed
-- before `parent` was declared, and `body`'s second owning operation on them.

-- ---------------------------------------------------------------------------
-- A preset field in the way is refused by name.
-- ---------------------------------------------------------------------------

-- `uuid_3` and the key `parent` were free on the comment type. A preset field
-- already holding either is not the core's to move, so this migration
-- refuses, naming it. No preset extends the comment type today.
do $$
declare
  held record;
begin
  select f.business_id, f.key, f.slot
    into held
    from public.field_defs f
    join public.record_types t on t.business_id = f.business_id and t.id = f.record_type_id
   where t.key = 'task_comment' and f.origin <> 'core'
     and (f.slot = 'uuid_3' or f.key = 'parent')
   limit 1;
  if found then
    raise exception 'field_defs: comment field % holds %, which replies reserve (business %)',
      held.key, held.slot, held.business_id
      using errcode = 'check_violation';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The field, on every comment type already installed.
-- ---------------------------------------------------------------------------

-- The row `installTaskSpine` writes for a new business: a uuid owned by
-- `task.comment`, shared, core. A type that already has it is left alone.
insert into public.field_defs
  (business_id, id, record_type_id, key, label, value_type, slot, write_mode,
   owning_operation, escalating_operation, visibility_class, searchable,
   unique_value, origin)
select t.business_id, gen_random_uuid(), t.id, 'parent', 'Reply to', 'uuid', 'uuid_3',
       'operation', array['task.comment'], null, 'shared', false, false, 'core'
  from public.record_types t
 where t.key = 'task_comment'
   and not exists (
     select 1 from public.field_defs f
      where f.business_id = t.business_id and f.record_type_id = t.id and f.key = 'parent'
   );

-- ---------------------------------------------------------------------------
-- The body's second owner.
-- ---------------------------------------------------------------------------

update public.field_defs f
   set owning_operation = array['task.comment', 'task.edit_comment']
  from public.record_types t
 where t.business_id = f.business_id and t.id = f.record_type_id
   and t.key = 'task_comment' and f.key = 'body' and f.origin = 'core'
   and f.owning_operation = array['task.comment'];
