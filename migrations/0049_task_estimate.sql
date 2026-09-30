-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0049 the estimate (MP-4-8, CS-4.14).
--
-- The time the burn bar and time logged measure against, in whole minutes. A
-- task spine field keyed `estimated_minutes`
-- (`packages/core-records/src/tasks/spine.ts`), numeric, unslotted and
-- generic, as the fixed-slots contract classifies it: written through
-- `task.update` under `task:write`, internal to the business. `task.update`
-- keeps only whole minutes from 0 to 1,000,000. Like every task field it is a
-- metadata row, not a column (ADR 0037). What cannot be a row is here: the
-- field row for the task types installed before the estimate was declared.

-- ---------------------------------------------------------------------------
-- A preset field that already holds the key, moved aside.
-- ---------------------------------------------------------------------------

-- The same move 0042, 0043, 0045 and 0048 make, for the same reason: a
-- preset field keyed `estimated_minutes` would keep the key, the insert below
-- would skip it, and the core's estimate would be a preset's field with a
-- preset's slot and visibility. Its definition and every value stored under
-- it move to `preset_estimated_minutes`, unchanged, and a business that
-- already has that key fails here by name rather than lose either.
do $$
declare
  held record;
begin
  for held in
    select f.*
      from public.field_defs f
      join public.record_types t on t.business_id = f.business_id and t.id = f.record_type_id
     where t.key = 'task' and f.origin <> 'core' and f.key = 'estimated_minutes'
  loop
    if exists (
      select 1 from public.field_defs f
       where f.business_id = held.business_id and f.record_type_id = held.record_type_id
         and f.key = 'preset_estimated_minutes'
    ) then
      raise exception 'field_defs: task field estimated_minutes cannot move aside to preset_estimated_minutes, which is taken (business %)',
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
      (held.business_id, gen_random_uuid(), held.record_type_id, 'preset_estimated_minutes', held.label,
       held.value_type, held.slot, held.write_mode, held.owning_operation,
       held.escalating_operation, held.visibility_class, held.searchable,
       held.unique_value, held.origin, held.created_at, held.deactivated_at);
    update public.records
       set data = (data - 'estimated_minutes') || jsonb_build_object('preset_estimated_minutes', data -> 'estimated_minutes')
     where business_id = held.business_id and record_type_id = held.record_type_id
       and data ? 'estimated_minutes';
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- The field, on every task type already installed.
-- ---------------------------------------------------------------------------

-- The row `installTaskSpine` writes for a new business: numeric, no slot,
-- generic, internal, core. A type that already has the core field is left
-- alone.
insert into public.field_defs
  (business_id, id, record_type_id, key, label, value_type, slot, write_mode,
   owning_operation, escalating_operation, visibility_class, searchable,
   unique_value, origin)
select t.business_id, gen_random_uuid(), t.id, 'estimated_minutes', 'Estimate', 'numeric', null,
       'generic', null, null, 'internal', false, false, 'core'
  from public.record_types t
 where t.key = 'task'
   and not exists (
     select 1 from public.field_defs f
      where f.business_id = t.business_id and f.record_type_id = t.id and f.key = 'estimated_minutes'
   );
