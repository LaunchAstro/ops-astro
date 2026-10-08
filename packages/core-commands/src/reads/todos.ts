// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.todos` (MP-7-1, CS-7.23): the reader's own to-dos. An open task
// assigned to the reader's person, in the reader's business, on any board or
// none. Open is the rank's rule: not completed, not cancelled and not archived
// by its parent's completion. Scoped (MP-7-2, CS-7.4), a teammate's open tasks
// or every open task under one client (`client`, the task's party), whoever
// holds it.
//
// **The scope is in the query.** The business and the assignee or client are
// all filters of the one select, so nothing outside the scope is read and
// then dropped, and one of the two is always set. The catalogue asks
// `task:read` of the whole business before this runs, so a reader held to one
// client's records never reaches it, scoped or not.
//
// Each row carries its tags (MP-4-11) and the count of top-level client
// messages owed a reply by the team (DT-19 `owed`), derived from the thread as
// `task.read` derives it, so the list and the page cannot disagree. It also
// carries its category and whose move it is (DP-14), read from the same
// gates and leases `task.read`'s proposals answer, asked only of the rows
// served.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { TodoView } from '../../../core-wire/src/index.ts';
import type { TaskSpine } from '../commands/context.ts';
import { SELECT, summaryOf, type TaskRowRead } from './tasks.ts';
import { extrasForTasks, movesOf, OPEN_TODO_SQL, type TodoScope } from './todo-evidence.ts';

/** The scope's open tasks, soonest due first, then oldest. */
export async function readTodos(
  tx: TenantQuery,
  spine: TaskSpine,
  scope: TodoScope,
): Promise<readonly TodoView[]> {
  const person = scope.person ?? null;
  const client = scope.client ?? null;
  const rows = await tx.query<TaskRowRead>(
    `${SELECT}
      where r.business_id = $1 and r.record_type_id = $2 and r.deleted_at is null
        and ($3::uuid is null or r.uuid_2 = $3::uuid)
        and ($4::uuid is null or r.uuid_7 = $4::uuid)
        and ${OPEN_TODO_SQL}
      order by r.ts_1 nulls last, r.created_at, r.id`,
    [tx.businessId, spine.taskTypeId, person, client],
  );
  const moves = await movesOf(
    tx,
    rows.map((row) => row.id),
  );
  const extras = await extrasForTasks(
    tx,
    spine,
    rows.map((row) => row.id),
  );
  const todos: TodoView[] = [];
  for (const row of rows) {
    todos.push({
      ...summaryOf(row),
      ...(extras.get(row.id) ?? { tags: [], waitingComments: 0 }),
      category: row.category,
      whoseMove: moves.get(row.id) ?? 'Team',
    });
  }
  return todos;
}
