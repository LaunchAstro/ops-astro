// SPDX-License-Identifier: AGPL-3.0-only
//
// Moving a task from one state to another, and the completion stamp that
// follows from it.
//
// There is no `status` column, no dual write and no derived coarse field
// anywhere (specification, 14.5). `state` is a link to a task-state record and
// the state record carries the machine category, so "is this done" is a
// property of the state a task points at rather than a second field that can
// disagree with it. Removing the coarse path removes no capability: it moves
// the coarseness into data, where a preset can change it without a migration.
//
// The completion stamp rides along in the same statement, which is what makes
// 14.1's precedence question not arise. `task.complete` and `task.reopen` are
// the same pair of operations reaching this function with a different state,
// and no third writer exists on any surface.

import type { TenantQuery } from '../tenancy/database.ts';
import { refuse, type RecordsRefusal } from '../records/refusals.ts';
import { completionStampFor } from './placement.ts';
import type { MachineCategory } from './states.ts';

export interface TaskStateRow {
  readonly id: string;
  readonly key: string;
  readonly machineCategory: MachineCategory;
}

/** The states an installation has, in the order a board draws them. */
export async function readTaskStates(
  tx: TenantQuery,
  taskStateTypeId: string,
): Promise<readonly TaskStateRow[]> {
  const rows = await tx.query<{
    readonly id: string;
    readonly key: string;
    readonly machine_category: MachineCategory;
  }>(
    `select id, data ->> 'key' as key, data ->> 'machine_category' as machine_category
       from records
      where business_id = $1 and record_type_id = $2 and deleted_at is null
      order by num_1`,
    [tx.businessId, taskStateTypeId],
  );
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    machineCategory: row.machine_category,
  }));
}

/**
 * Point a task at a state, and set or clear the completion stamp with it.
 *
 * One statement, so the stamp and the state cannot be observed apart. The
 * stamp is written into `data` because a slot is never written directly — the
 * trigger projects `ts_2` from the key — and it is **removed** rather than set
 * to null when the state is not a completed one, so the record carries no key
 * whose value is "not completed".
 *
 * Reopening clears the field and does not clear the history: the completion
 * event stays in the audit with its actor and time, once T1f writes one.
 */
export async function setTaskState(
  tx: TenantQuery,
  options: {
    readonly taskId: string;
    readonly stateId: string;
    readonly taskStateTypeId: string;
    readonly now?: Date;
  },
): Promise<{ readonly completedAt: Date | null } | RecordsRefusal> {
  const states = await readTaskStates(tx, options.taskStateTypeId);
  const state = states.find((candidate) => candidate.id === options.stateId);
  if (state === undefined) {
    return refuse(
      'NOT_FOUND',
      ['state'],
      [
        'No task state of this installation carries that identifier.',
        `The states installed are: ${states.map((each) => each.key).join(', ')}.`,
      ],
    );
  }

  const completedAt = completionStampFor(state.machineCategory, options.now ?? new Date());
  const updated = await tx.query<{ readonly id: string }>(
    `update records
        set data = case
              when $4::timestamptz is null
                then (data - 'completed_at') || jsonb_build_object('state', $3::text)
              else data || jsonb_build_object('state', $3::text, 'completed_at', $4::text)
            end
      where business_id = $1 and id = $2 and deleted_at is null
      returning id`,
    [tx.businessId, options.taskId, options.stateId, completedAt],
  );
  if (updated.length === 0) {
    return refuse('NOT_FOUND', ['task'], ['No live task carries that identifier here.']);
  }
  return { completedAt };
}
