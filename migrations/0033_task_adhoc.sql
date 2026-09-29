-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0033 the Ad hoc mark (MP-4-10, CS-4.9).
--
-- A task marked ad hoc drives billing and is the default for its new time
-- entries. It is a task spine field owned by `task.set_adhoc`
-- (`packages/core-records/src/tasks/spine.ts`), so like every task field it is
-- a metadata row over a fixed slot, not a column of a tasks table (ADR 0037).
-- What cannot be a row is here: the reservation of `bool_2`, and the field
-- rows for the task types installed before the mark was declared. The mark is
-- true, false or absent, and absent reads as not ad hoc.

-- ---------------------------------------------------------------------------
-- One more reserved slot.
-- ---------------------------------------------------------------------------

-- `bool_2` was free for a preset field, and its index exists (0009). A preset
-- field already holding it is not the core's to move, so this migration
-- refuses, naming it. No preset ships a boolean field on a task today.
do $$
declare
  held record;
begin
  select f.business_id, f.record_type_id, f.key, f.slot
    into held
    from public.field_defs f
   where f.slot = 'bool_2' and f.origin <> 'core'
   limit 1;
  if found then
    raise exception 'field_defs: % holds %, which the ad hoc mark reserves (record type % in business %)',
      held.key, held.slot, held.record_type_id, held.business_id
      using errcode = 'check_violation';
  end if;
end;
$$;

update ops.slots set reservation = 'task_spine' where slot = 'bool_2';

-- ---------------------------------------------------------------------------
-- A preset field that already holds the key, moved aside.
-- ---------------------------------------------------------------------------

-- The same move 0032 makes for the marks, for the same reason: a preset field
-- keyed `ad_hoc` on a task type would keep the key, the backfill below would
-- skip it, and `task.set_adhoc` would refuse the mark as a field it does not
-- own. Its definition and every value stored under it move to
-- `preset_ad_hoc`, unchanged, and a business that already has that key fails
-- here by name rather than lose either.
do $$
declare
  held record;
begin
  for held in
    select f.*
      from public.field_defs f
      join public.record_types t on t.business_id = f.business_id and t.id = f.record_type_id
     where t.key = 'task' and f.origin <> 'core' and f.key = 'ad_hoc'
  loop
    if exists (
      select 1 from public.field_defs f
       where f.business_id = held.business_id and f.record_type_id = held.record_type_id
         and f.key = 'preset_ad_hoc'
    ) then
      raise exception 'field_defs: task field ad_hoc cannot move aside to preset_ad_hoc, which is taken (business %)',
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
      (held.business_id, gen_random_uuid(), held.record_type_id, 'preset_ad_hoc', held.label,
       held.value_type, held.slot, held.write_mode, held.owning_operation,
       held.escalating_operation, held.visibility_class, held.searchable,
       held.unique_value, held.origin, held.created_at, held.deactivated_at);
    update public.records
       set data = (data - 'ad_hoc') || jsonb_build_object('preset_ad_hoc', data -> 'ad_hoc')
     where business_id = held.business_id and record_type_id = held.record_type_id
       and data ? 'ad_hoc';
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- The field, on every task type already installed.
-- ---------------------------------------------------------------------------

-- The row `installTaskSpine` writes for a new business: boolean, owned by
-- `task.set_adhoc`, internal, core. A type that already has the core field is
-- left alone.
insert into public.field_defs
  (business_id, id, record_type_id, key, label, value_type, slot, write_mode,
   owning_operation, escalating_operation, visibility_class, searchable,
   unique_value, origin)
select t.business_id, gen_random_uuid(), t.id, 'ad_hoc', 'Ad hoc', 'boolean', 'bool_2',
       'operation', array['task.set_adhoc'], null, 'internal', false, false, 'core'
  from public.record_types t
 where t.key = 'task'
   and not exists (
     select 1 from public.field_defs f
      where f.business_id = t.business_id and f.record_type_id = t.id and f.key = 'ad_hoc'
   );
