// SPDX-License-Identifier: AGPL-3.0-only
//
// Which of a board's tasks wait at a gate: the run awaiting approval, the one
// wait main's run lifecycle stores (MP-5-11's waiting reason, `needs_approval`),
// and the rows the Review mode draws and counts (MP-5-12, CS-5.12).
//
// A task waits at a gate when a gate on its live proposal version is pending
// and has not expired; one decided, expired or superseded waits on nobody. The
// question is asked only of the tasks the board already serves, so it never
// names, counts or reads a gate on a task the caller cannot read. Whether the
// wait is the caller's to end is the board's question, not this one's.

import type { TenantQuery } from '../../../core-records/src/index.ts';

/** The served tasks with a gate waiting for a decision. */
export async function awaitingApproval(
  tx: TenantQuery,
  taskIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (taskIds.length === 0) return new Set();
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
        and run.task_id = any($2::uuid[])`,
    [tx.businessId, taskIds],
  );
  return new Set(rows.map((row) => row.task_id));
}
