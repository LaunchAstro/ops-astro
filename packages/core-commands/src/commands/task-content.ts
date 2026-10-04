// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: whether a task has content, the one answer that locks its client
// (owner line 75). `task.set_party` asks it under the task's row lock
// (`task-client-lock.ts`); `task.read` sends it to a member, with the task's
// client, for the Client field (MP-4-8), so the field and the lock never
// disagree about a task they both see. `task.board` sends each row's client by
// the same rule (the Clients row door), so the board and the field agree too.

import { clientsReached, type Subject, type TenantQuery } from '../../../core-records/src/index.ts';
import { COMMAND_SURFACE, type ClientView } from '../../../core-wire/src/index.ts';

/**
 * Writes whose history event is content; creation and client changes are not.
 * A duplicate is a creation too (CS-4.12): its steps are subtasks, which count.
 */
const CONTENT_COMMANDS: readonly string[] = COMMAND_SURFACE.filter(
  (declaration) =>
    declaration.kind === 'write' &&
    !['task.create', 'task.duplicate', 'task.set_party'].includes(declaration.name),
).map((declaration) => declaration.name);

/**
 * Content is an applied write beyond creation and client changes, or a row
 * naming the task: a subtask, a proposal, a planned run, an envelope, a
 * lease, an alert, a time entry (deleted or not: a time event names no
 * subject, RS-VAULT-9, so the entry's row is what the lock reads), a live
 * correction (its audit event names the correction, not the task, and its
 * party is pinned to the client it was filed under).
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
         or exists (select 1 from alerts where business_id = $1 and task_id = $2)
         or exists (select 1 from time_entries where business_id = $1 and task_id = $2)
         or exists (select 1 from live_corrections where business_id = $1 and task_id = $2)
           as content`,
    [tx.businessId, taskId, CONTENT_COMMANDS],
  );
  return row?.content !== false;
}

/**
 * What the Client field reads (MP-4-8): the client the task is under, by id
 * (`records.uuid_7`), and whether it has content, the lock's own answer. The
 * id goes only to a reader whose grants reach that client, `client.list`'s
 * rule (a grant across the business, or one on the client); anyone else reads
 * null, and the task's `clientSet` says it is under one (CS-4.12). The
 * client's name is `client.list`'s to send, never this.
 */
export async function readClientFacts(
  tx: TenantQuery,
  taskId: string,
  subjects: readonly Subject[],
): Promise<{ readonly client: string | null; readonly hasContent: boolean }> {
  const [row] = await tx.query<{ readonly client: string | null }>(
    'select uuid_7 as client from records where business_id = $1 and id = $2',
    [tx.businessId, taskId],
  );
  const client = row?.client ?? null;
  const reached = client === null ? [] : ((await clientsReached(tx, subjects)) ?? []);
  return {
    client: reached.some((one) => one.clientId === client) ? client : null,
    hasContent: await hasContent(tx, taskId),
  };
}

/**
 * The served board rows, each with its client (the Clients row door), by
 * `readClientFacts`' rule: the id and `client.list`'s name only where the
 * reader's grants reach the client; null for none, and null for a client they
 * do not reach, whose row's `clientSet` says it is under one. Asked only of the
 * rows served.
 */
export async function withBoardClients<Row extends { readonly id: string }>(
  tx: TenantQuery,
  served: readonly Row[],
  subjects: readonly Subject[],
): Promise<readonly (Row & { readonly client: ClientView | null })[]> {
  const rows =
    served.length === 0
      ? []
      : await tx.query<{ readonly id: string; readonly client: string }>(
          `select id, uuid_7 as client from records
            where business_id = $1 and id = any($2::uuid[]) and uuid_7 is not null`,
          [tx.businessId, served.map((row) => row.id)],
        );
  const among = [...new Set(rows.map((row) => row.client))];
  const reached = new Map(
    among.length === 0
      ? []
      : ((await clientsReached(tx, subjects, among)) ?? []).map((one) => [one.clientId, one]),
  );
  const clientOf = new Map(rows.map((row) => [row.id, reached.get(row.client) ?? null]));
  return served.map((row) => ({ ...row, client: clientOf.get(row.id) ?? null }));
}
