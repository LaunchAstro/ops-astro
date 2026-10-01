// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: whether a task has content, the one answer that locks its client
// (owner line 75). `task.set_party` asks it under the task's row lock
// (`task-client-lock.ts`); `task.read` sends it to a member, with the task's
// client, for the Client field (MP-4-8), so the field and the lock never
// disagree about a task they both see.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import { COMMAND_SURFACE } from '../../../core-wire/src/index.ts';

/** Writes whose history event is content; creation and client changes are not. */
const CONTENT_COMMANDS: readonly string[] = COMMAND_SURFACE.filter(
  (declaration) =>
    declaration.kind === 'write' && !['task.create', 'task.set_party'].includes(declaration.name),
).map((declaration) => declaration.name);

/**
 * Content is an applied write beyond creation and client changes, or a row
 * naming the task: a subtask, a proposal, a planned run, an envelope, a
 * lease, an alert.
 */
export async function hasContent(tx: TenantQuery, taskId: string): Promise<boolean> {
  const [row] = await tx.query<{ readonly content: boolean }>(
    `select exists (select 1 from audit_events where business_id = $1 and subject_record_id = $2
                      and outcome = 'applied' and command = any($3::text[]))
         or exists (select 1 from records r where r.business_id = $1 and r.uuid_4 = $2
                      and r.record_type_id = (select record_type_id from records where id = $2))
         or exists (select 1 from proposal_lineages where business_id = $1 and task_id = $2)
         or exists (select 1 from planned_runs where business_id = $1 and task_id = $2)
         or exists (select 1 from task_envelopes where business_id = $1 and task_id = $2)
         or exists (select 1 from leases where business_id = $1 and task_id = $2)
         or exists (select 1 from alerts where business_id = $1 and task_id = $2) as content`,
    [tx.businessId, taskId, CONTENT_COMMANDS],
  );
  return row?.content !== false;
}

/**
 * What the Client field reads (MP-4-8): the client the task is under, by id
 * (`records.uuid_7`), and whether it has content, the lock's own answer. The client's name is `client.list`'s to send, never this.
 */
export async function readClientFacts(
  tx: TenantQuery,
  taskId: string,
): Promise<{ readonly client: string | null; readonly hasContent: boolean }> {
  const [row] = await tx.query<{ readonly client: string | null }>(
    'select uuid_7 as client from records where business_id = $1 and id = $2',
    [tx.businessId, taskId],
  );
  return { client: row?.client ?? null, hasContent: await hasContent(tx, taskId) };
}
