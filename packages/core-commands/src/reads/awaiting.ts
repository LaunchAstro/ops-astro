// SPDX-License-Identifier: AGPL-3.0-only
//
// Which of a board's tasks wait at a gate for the caller's decision
// (MP-5-12, CS-5.12, the Review mode's rows and live count).
//
// A task waits on the caller when a gate on its live proposal version is
// pending and has not expired, and the caller's decide grant reaches the task:
// the grant `task.decide` checks before it decides (`checkAuthority` with
// action `decide` on the task record, `decide.ts`). The decide reach comes
// from `readableScope`, the same live-grant expression. The question is asked
// only of the tasks the board already serves, so it never names, counts or
// reads a gate on a task the caller cannot read, and a pending gate that has
// expired, been decided or been superseded waits on nobody.

import type { TenantQuery } from '../../../core-records/src/index.ts';

/**
 * The served tasks that wait on the caller. `decidable` is null for a
 * business-wide decide grant, otherwise the tasks the caller's record-scoped
 * decide grants reach (empty for none).
 */
export async function awaitingDecision(
  tx: TenantQuery,
  taskIds: readonly string[],
  decidable: readonly string[] | null,
): Promise<ReadonlySet<string>> {
  if (taskIds.length === 0 || (decidable !== null && decidable.length === 0)) return new Set();
  const rows = await tx.query<{ readonly task_id: string }>(
    `select distinct run.task_id
       from public.gates g
       join public.planned_runs run
         on run.business_id = g.business_id and run.id = g.run_id
       join public.proposal_versions ver
         on ver.business_id = g.business_id and ver.id = g.version_id
      where g.business_id = $1
        and g.state = 'pending' and g.expires_at > now()
        and ver.superseded_at is null
        and run.task_id = any($2::uuid[])
        and ($3::uuid[] is null or run.task_id = any($3::uuid[]))`,
    [tx.businessId, taskIds, decidable],
  );
  return new Set(rows.map((row) => row.task_id));
}
