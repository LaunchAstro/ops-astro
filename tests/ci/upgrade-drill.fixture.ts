// SPDX-License-Identifier: AGPL-3.0-only
// Historical row-change migrations planted by the upgrade drill proofs.

interface Declaration {
  readonly table: string;
  readonly columns: readonly string[];
  readonly where: string;
}

export interface Planted {
  readonly version: string;
  readonly sql: string;
  readonly changes?: readonly Declaration[];
}

export const MARKS: Planted = {
  version: '9996_planted_marks',
  sql: `update ops.slots set reservation = 'task_spine' where slot in ('num_3', 'num_4', 'num_5')`,
  changes: [
    {
      table: 'ops.slots',
      columns: ['reservation'],
      where: `slot in ('num_3', 'num_4', 'num_5')`,
    },
  ],
};
export const AD_HOC: Planted = {
  version: '9997_planted_adhoc',
  sql: `update ops.slots set reservation = 'task_spine' where slot = 'bool_2'`,
  changes: [{ table: 'ops.slots', columns: ['reservation'], where: `slot = 'bool_2'` }],
};
export const COMMENT_OWNERS: Planted = {
  version: '9998_planted_comment_owners',
  sql: `update public.field_defs f set owning_operation = array['task.comment', 'task.edit_comment']
          from public.record_types t
         where t.business_id = f.business_id and t.id = f.record_type_id
           and t.key = 'task_comment' and f.key = 'body' and f.origin = 'core'
           and f.owning_operation = array['task.comment']`,
  changes: [
    {
      table: 'public.field_defs',
      columns: ['owning_operation'],
      where: `key = 'body' and origin = 'core' and record_type_id in
                (select id from public.record_types where key = 'task_comment')`,
    },
  ],
};
export const STATE_OWNERS: Planted = {
  version: '9999_planted_state_owners',
  sql: `update public.field_defs f
           set owning_operation = array['task.complete', 'task.reopen', 'task.set_state', 'task.start']
          from public.record_types t
         where t.business_id = f.business_id and t.id = f.record_type_id
           and t.key = 'task' and f.key = 'state' and f.origin = 'core'
           and f.owning_operation = array['task.complete', 'task.reopen', 'task.start']`,
  changes: [
    {
      table: 'public.field_defs',
      columns: ['owning_operation'],
      where: `key = 'state' and origin = 'core' and record_type_id in
                (select id from public.record_types where key = 'task')`,
    },
  ],
};
