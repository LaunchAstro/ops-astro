-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0140 the agent assignee (Assign to AI).
--
-- A task's assignee is a person or an agent. The agent is a live delegation
-- a person holds for that task (`delegations`, 0008), recorded in a task
-- spine field keyed `agent` (`packages/core-records/src/tasks/spine.ts`):
-- uuid, unslotted, written only by `task.assign`, internal to the business.
-- `task.assign` keeps one kind at a time, takes only the assigner's own live
-- delegation for that task, and a revoke clears the field from every task
-- holding the delegation. Like every task field it is a metadata row, not a
-- column (ADR 0037); this is the field row for task types installed before
-- the agent was declared.

-- ---------------------------------------------------------------------------
-- A preset field that already holds the key, moved aside.
-- ---------------------------------------------------------------------------

-- The same move 0131, 0132, 0134, 0137 and 0138 make, for the same reason: a
-- preset field keyed `agent` would keep the key, the insert below
-- would skip it, and the core's agent would be a preset's field with a
-- preset's slot and visibility. Its definition and every value stored under
-- it move to `preset_agent`, unchanged, and a business that
-- already has that key fails here by name rather than lose either.
do $$
declare
  held record;
begin
  for held in
    select f.*
      from public.field_defs f
      join public.record_types t on t.business_id = f.business_id and t.id = f.record_type_id
     where t.key = 'task' and f.origin <> 'core' and f.key = 'agent'
  loop
    if exists (
      select 1 from public.field_defs f
       where f.business_id = held.business_id and f.record_type_id = held.record_type_id
         and f.key = 'preset_agent'
    ) then
      raise exception 'field_defs: task field agent cannot move aside to preset_agent, which is taken (business %)',
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
      (held.business_id, gen_random_uuid(), held.record_type_id, 'preset_agent', held.label,
       held.value_type, held.slot, held.write_mode, held.owning_operation,
       held.escalating_operation, held.visibility_class, held.searchable,
       held.unique_value, held.origin, held.created_at, held.deactivated_at);
    update public.records
       set data = (data - 'agent') || jsonb_build_object('preset_agent', data -> 'agent')
     where business_id = held.business_id and record_type_id = held.record_type_id
       and data ? 'agent';
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- The field, on every task type already installed.
-- ---------------------------------------------------------------------------

-- The row `installTaskSpine` writes for a new business: uuid, no slot,
-- owned by task.assign, internal, core. A type that already has the core field is left
-- alone.
insert into public.field_defs
  (business_id, id, record_type_id, key, label, value_type, slot, write_mode,
   owning_operation, escalating_operation, visibility_class, searchable,
   unique_value, origin)
select t.business_id, gen_random_uuid(), t.id, 'agent', 'Agent', 'uuid', null,
       'operation', array['task.assign'], null, 'internal', false, false, 'core'
  from public.record_types t
 where t.key = 'task'
   and not exists (
     select 1 from public.field_defs f
      where f.business_id = t.business_id and f.record_type_id = t.id and f.key = 'agent'
   );
