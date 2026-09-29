-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0034 a step archived by its parent's completion (MP-4-15, CS-4.2).
--
-- Completing a task marks its unfinished subtasks archived, never done, and
-- reopening it restores them (`task.complete` and `task.reopen`,
-- `packages/core-commands/src/commands/tasks-state.ts`). The mark is two task
-- spine fields, `archived_at` and `archived_why`, system-written like
-- `completed_at` and unslotted like `description`
-- (`packages/core-records/src/tasks/spine.ts`), so, like every task field,
-- they are metadata rows, not columns (ADR 0037). What cannot be a row is
-- here: the field rows for the task types installed before the mark was
-- declared, and a preset field already holding either key moved aside.

-- ---------------------------------------------------------------------------
-- A preset field that already holds a key, moved aside.
-- ---------------------------------------------------------------------------

-- The move 0033 makes for `ad_hoc`, for the same reason: a preset field keyed
-- `archived_at` or `archived_why` on a task type would keep the key, the
-- backfill below would skip it, and the transition would write a value into a
-- field it does not own. Its definition and every value stored under it move
-- to `preset_<key>`, unchanged, and a business that already has that key fails
-- here by name rather than lose either.
do $$
declare
  held record;
begin
  for held in
    select f.*
      from public.field_defs f
      join public.record_types t on t.business_id = f.business_id and t.id = f.record_type_id
     where t.key = 'task' and f.origin <> 'core' and f.key in ('archived_at', 'archived_why')
  loop
    if exists (
      select 1 from public.field_defs f
       where f.business_id = held.business_id and f.record_type_id = held.record_type_id
         and f.key = 'preset_' || held.key
    ) then
      raise exception 'field_defs: task field % cannot move aside to preset_%, which is taken (business %)',
        held.key, held.key, held.business_id
        using errcode = 'unique_violation';
    end if;
    delete from public.record_unique_values
     where business_id = held.business_id and field_def_id = held.id;
    delete from public.field_defs where business_id = held.business_id and id = held.id;
    insert into public.field_defs
      (business_id, id, record_type_id, key, label, value_type, slot, write_mode,
       owning_operation, escalating_operation, visibility_class, searchable,
       unique_value, origin, created_at, deactivated_at)
    values
      (held.business_id, gen_random_uuid(), held.record_type_id, 'preset_' || held.key, held.label,
       held.value_type, held.slot, held.write_mode, held.owning_operation,
       held.escalating_operation, held.visibility_class, held.searchable,
       held.unique_value, held.origin, held.created_at, held.deactivated_at);
    update public.records
       set data = (data - held.key) || jsonb_build_object('preset_' || held.key, data -> held.key)
     where business_id = held.business_id and record_type_id = held.record_type_id
       and data ? held.key;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- The fields, on every task type already installed.
-- ---------------------------------------------------------------------------

-- The rows `installTaskSpine` writes for a new business: system, unslotted,
-- internal, core. A type that already has the core field is left alone.
insert into public.field_defs
  (business_id, id, record_type_id, key, label, value_type, slot, write_mode,
   owning_operation, escalating_operation, visibility_class, searchable,
   unique_value, origin)
select t.business_id, gen_random_uuid(), t.id, f.key, f.label, f.value_type, null,
       'system', null, null, 'internal', false, false, 'core'
  from public.record_types t
 cross join (values ('archived_at', 'Archived at', 'timestamptz'),
                    ('archived_why', 'Archived why', 'text')) as f (key, label, value_type)
 where t.key = 'task'
   and not exists (
     select 1 from public.field_defs d
      where d.business_id = t.business_id and d.record_type_id = t.id and d.key = f.key
   );
