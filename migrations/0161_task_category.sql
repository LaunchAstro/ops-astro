-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0161 the task category (MP-4-8, CS-4.16, DP-23; BUILDABLE-NOW (b)4).
--
-- A task's work label: one of the nine ids of `TASK_CATEGORIES`
-- (`packages/core-wire/src/task-categories.ts`), or absent. A task spine field
-- keyed `category` (`packages/core-records/src/tasks/spine.ts`), text,
-- unslotted, owned by `task.set_category` under `task:write`, internal to the
-- business. It is a label and nothing more (R76): no grant, delegation or scope
-- reads it. Like every task field it is a metadata row, not a column (ADR
-- 0037). What cannot be a row is here: the field row for the task types
-- installed before the category was declared.

-- ---------------------------------------------------------------------------
-- A preset field that already holds the key, moved aside.
-- ---------------------------------------------------------------------------

-- The same move 0131, 0132, 0134, 0137 and 0138 make, for the same reason: a
-- preset field keyed `category` would keep the key, the insert below would
-- skip it, and `task.set_category` would refuse the label as a field it does
-- not own. No preset ships one today. Its definition and every value stored
-- under it move to `preset_category`, unchanged, and a business that already
-- has that key fails here by name rather than lose either.
do $$
declare
  held record;
begin
  for held in
    select f.*
      from public.field_defs f
      join public.record_types t on t.business_id = f.business_id and t.id = f.record_type_id
     where t.key = 'task' and f.origin <> 'core' and f.key = 'category'
  loop
    if exists (
      select 1 from public.field_defs f
       where f.business_id = held.business_id and f.record_type_id = held.record_type_id
         and f.key = 'preset_category'
    ) then
      raise exception 'field_defs: task field category cannot move aside to preset_category, which is taken (business %)',
        held.business_id
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
      (held.business_id, gen_random_uuid(), held.record_type_id, 'preset_category', held.label,
       held.value_type, held.slot, held.write_mode, held.owning_operation,
       held.escalating_operation, held.visibility_class, held.searchable,
       held.unique_value, held.origin, held.created_at, held.deactivated_at);
    update public.records
       set data = (data - 'category') || jsonb_build_object('preset_category', data -> 'category')
     where business_id = held.business_id and record_type_id = held.record_type_id
       and data ? 'category';
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- The field, on every task type already installed.
-- ---------------------------------------------------------------------------

-- The row `installTaskSpine` writes for a new business: text, no slot, owned
-- by `task.set_category`, internal, core. A type that already has the core
-- field is left alone.
insert into public.field_defs
  (business_id, id, record_type_id, key, label, value_type, slot, write_mode,
   owning_operation, escalating_operation, visibility_class, searchable,
   unique_value, origin)
select t.business_id, gen_random_uuid(), t.id, 'category', 'Category', 'text', null,
       'operation', array['task.set_category'], null, 'internal', false, false, 'core'
  from public.record_types t
 where t.key = 'task'
   and not exists (
     select 1 from public.field_defs f
      where f.business_id = t.business_id and f.record_type_id = t.id and f.key = 'category'
   );
