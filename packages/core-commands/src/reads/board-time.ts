// SPDX-License-Identifier: AGPL-3.0-only
//
// The Actual column's minutes (MP-5-8, P-21): each served board row's time
// total, derived at read from the time entries (MP-4-6) and never stored on
// the board. It is the total `readTaskTime` answers on `task.read` (every
// finished minute on the task, one number with no names behind it:
// RS-VAULT-9), summed for the whole board in one query rather than one per
// row. `mp-5-8-board-actual` reads each row back against `task.read`.

import type { TenantQuery } from '../../../core-records/src/index.ts';

/**
 * The finished minutes on each of `taskIds`, by task; a task with none is
 * absent. Asked only of the rows the board serves, inside the business, so a
 * task outside the reader's scope is never summed.
 */
export async function readActualMinutes(
  tx: TenantQuery,
  taskIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const rows = await tx.query<{ readonly task_id: string; readonly minutes: number }>(
    `select task_id, coalesce(sum(minutes), 0)::int as minutes from public.time_entries
      where business_id = $1 and task_id = any($2::uuid[]) and deleted_at is null
      group by task_id`,
    [tx.businessId, taskIds],
  );
  return new Map(rows.map((row) => [row.task_id, row.minutes]));
}
