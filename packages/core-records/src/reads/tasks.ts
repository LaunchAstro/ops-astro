// SPDX-License-Identifier: AGPL-3.0-only
//
// Reading a task, and reading the tasks on a board.
//
// Both read the **slots**, not `data`. The slots are the projection the field
// table fixes -- state `uuid_1`, assignee `uuid_2`, title `txt_4`, due `ts_1`,
// priority `num_1`, completed_at `ts_2` -- and reading them is what makes a
// read of a task and the trigger that writes it two halves of one claim. A read
// out of `data` would still return the right answer on a record the trigger had
// stopped projecting, which is the failure worth catching.
//
// `description` is the exception and has to be: it is unslotted on purpose
// (`tasks/spine.ts`), so `data` is where it lives.
//
// A task that is not here, and a task that is in another business, produce
// nothing to distinguish them: the query is scoped by the business the session
// set, so a foreign identifier simply matches no row and the caller is told
// NOT_FOUND -- the same answer, in the same shape, as an identifier that was
// never real.

import type { TenantQuery } from '../tenancy/database.ts';
import type { HistoryEntry, TaskDetail, TaskSummary } from './requests.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface TaskRowRead {
  readonly id: string;
  readonly revision: string;
  readonly key: string | null;
  readonly title: string | null;
  readonly due: Date | null;
  readonly priority: string | null;
  readonly completed_at: Date | null;
  readonly description: string | null;
  readonly state_id: string | null;
  readonly state_key: string | null;
  readonly state_label: string | null;
  readonly state_machine_category: string | null;
  readonly assignee_id: string | null;
  readonly assignee_name: string | null;
}

// `revision` is bigint and this driver hands a bigint back as a string, so it
// is read as text and converted once, here. `priority` is numeric, which is
// the same story for the same reason.
const SELECT = `
  select r.id,
         r.revision::text as revision,
         r.txt_1 as key,
         r.txt_4 as title,
         r.ts_1  as due,
         r.num_1::text as priority,
         r.ts_2  as completed_at,
         r.data ->> 'description' as description,
         s.id as state_id,
         s.data ->> 'key' as state_key,
         s.data ->> 'label' as state_label,
         s.data ->> 'machine_category' as state_machine_category,
         p.id as assignee_id,
         p.display_name as assignee_name
    from public.records r
    left join public.records s
      on s.business_id = r.business_id and s.id = r.uuid_1 and s.deleted_at is null
    left join public.people p
      on p.business_id = r.business_id and p.id = r.uuid_2`;

function summaryOf(row: TaskRowRead): TaskSummary {
  return {
    id: row.id,
    key: row.key ?? '',
    title: row.title,
    state:
      row.state_id === null
        ? null
        : {
            id: row.state_id,
            key: row.state_key ?? '',
            label: row.state_label ?? '',
            machineCategory: row.state_machine_category ?? '',
          },
    assignee:
      row.assignee_id === null
        ? null
        : { personId: row.assignee_id, name: row.assignee_name ?? '' },
    due: row.due === null ? null : row.due.toISOString(),
    priority: row.priority === null ? null : Number(row.priority),
    completedAt: row.completed_at === null ? null : row.completed_at.toISOString(),
    revision: Number(row.revision),
  };
}

/**
 * The applied attempts against this record, in the order they happened.
 *
 * Refused and replayed attempts are left out: history is what happened to the
 * task, and a refusal did not happen to it. They stay in `audit_events`, which
 * is where an operator looks and where the refusal evidence for N1 to N7 comes
 * from.
 */
async function historyOf(tx: TenantQuery, recordId: string): Promise<readonly HistoryEntry[]> {
  const rows = await tx.query<{
    readonly occurred_at: Date;
    readonly actor_id: string;
    readonly command: string;
  }>(
    `select occurred_at, actor_id, command
       from public.audit_events
      where business_id = $1 and subject_record_id = $2 and outcome = 'applied'
      order by seq`,
    [tx.businessId, recordId],
  );
  return rows.map((row) => ({
    at: row.occurred_at.toISOString(),
    actorId: row.actor_id,
    operation: row.command,
  }));
}

/**
 * The record a caller named, whether they named its identifier or its key.
 *
 * A task's address is its key -- `T-14`, the thing a person reads out and
 * types -- and `routes.ts` says so deliberately. The identifier is what the
 * record is stored under. Accepting both here is what lets the address in the
 * bar be the key while the read stays a read of one record, and it is one
 * lookup rather than a second read declaration.
 *
 * Nothing is cast that is not first matched: a value that is not a uuid is
 * never handed to Postgres as one, and a key that names nothing comes back
 * undefined, which the caller turns into the same `NOT_FOUND` a wrong business
 * gets.
 */
export async function resolveTaskId(
  tx: TenantQuery,
  taskTypeId: string,
  given: string,
): Promise<string | undefined> {
  if (UUID.test(given)) return given;
  const rows = await tx.query<{ readonly id: string }>(
    `select r.id from records r
      where r.business_id = $1 and r.record_type_id = $2 and r.txt_1 = $3
        and r.deleted_at is null`,
    [tx.businessId, taskTypeId, given],
  );
  return rows[0]?.id;
}

/** One task with its history, or nothing at all. */
export async function readTaskDetail(
  tx: TenantQuery,
  taskTypeId: string,
  recordId: string,
): Promise<TaskDetail | undefined> {
  // A malformed identifier is not cast and not queried. The cast would raise
  // where the contract promises a refusal, and "that is not a uuid" is an
  // answer a caller can learn from, which is one more than they should get.
  if (!UUID.test(recordId)) return undefined;
  const rows = await tx.query<TaskRowRead>(
    `${SELECT}
      where r.business_id = $1 and r.record_type_id = $2 and r.id = $3
        and r.deleted_at is null`,
    [tx.businessId, taskTypeId, recordId],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    ...summaryOf(row),
    description: row.description,
    history: await historyOf(tx, row.id),
  };
}

/**
 * The live tasks on one board, or the unboarded ones when the board is null.
 *
 * Unboarded is a real answer and not a missing filter: `task.create` takes no
 * board (acceptance B1), so every task starts here and a board read that
 * quietly returned everything would make the first case untestable.
 */
export async function readBoard(
  tx: TenantQuery,
  taskTypeId: string,
  board: string | null,
): Promise<readonly TaskSummary[]> {
  if (board !== null && !UUID.test(board)) return [];
  const rows = await tx.query<TaskRowRead>(
    `${SELECT}
      where r.business_id = $1 and r.record_type_id = $2 and r.deleted_at is null
        and (($3::uuid is null and r.uuid_5 is null) or r.uuid_5 = $3::uuid)
      order by r.num_2 nulls last, r.created_at`,
    [tx.businessId, taskTypeId, board],
  );
  return rows.map(summaryOf);
}
