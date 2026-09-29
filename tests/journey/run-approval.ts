// SPDX-License-Identifier: AGPL-3.0-only
//
// T4d: the approval the journey applied, as the run hands it to the command.
// The action is the decision row's payload exactly as the database holds it
// (`payload::text`), so the bundle can name it byte for byte.

import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';

/** The `journey-approval` line for the task's one decision; a task with none has no line. */
export async function approvalLine(
  admin: AdminConnection,
  businessId: string,
  taskId: string,
): Promise<string> {
  const rows = await admin.execute<{ id: string; decision: string; action: string }>(
    `select d.id, d.decision, d.payload::text as action from public.gate_decisions d
       join public.gates g on g.business_id = d.business_id and g.id = d.gate_id
       join public.proposal_lineages l on l.business_id = g.business_id and l.id = g.lineage_id
      where d.business_id = $1 and l.task_id = $2 and d.decision = 'approve'
      order by d.seq`,
    [businessId, taskId],
  );
  const [row] = rows;
  if (row === undefined || rows.length !== 1) {
    throw new Error(`journey: task ${taskId} has ${String(rows.length)} approvals, not one`);
  }
  const approval = { taskId, decisionId: row.id, decision: row.decision, action: row.action };
  return `journey-approval ${JSON.stringify(approval)}`;
}
