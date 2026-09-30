-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0141 the task state's fourth owner.
--
-- `task.set_state` points a task at one of its business's own states by the
-- state record's id, so the status select reaches Waiting on client, which
-- shares its machine category with Active, and On hold. It writes the task's
-- `state`, and a field names every command that may write it
-- (`packages/core-records/src/tasks/spine.ts`), so the core row gains it. A new
-- business gets the four from the spine; this is the row for the task types
-- installed before. Only the core row as the spine shipped it is changed, the
-- same guard 0133 puts on the comment body's second owner.

update public.field_defs f
   set owning_operation = array['task.complete', 'task.reopen', 'task.set_state', 'task.start']
  from public.record_types t
 where t.business_id = f.business_id and t.id = f.record_type_id
   and t.key = 'task' and f.key = 'state' and f.origin = 'core'
   and f.owning_operation = array['task.complete', 'task.reopen', 'task.start'];
