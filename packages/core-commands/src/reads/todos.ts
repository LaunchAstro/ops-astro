// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.todos` (MP-7-1, CS-7.23): the reader's own to-dos. An open task
// assigned to the reader's person, in the reader's business, on any board or
// none. Open is the rank's rule: not completed, not cancelled and not archived
// by its parent's completion.
//
// **The reader is in the query.** The business and the assignee are both
// filters of the one select, so nothing someone else holds is read and then
// dropped. The catalogue asks `task:read` of the whole business before this
// runs, so a reader held to one client's records never reaches it.
//
// Each row carries its tags (MP-4-11) and the count of top-level client
// messages owed a reply by the team (DT-19 `owed`), derived from the thread as
// `task.read` derives it, so the list and the page cannot disagree.

import { commentSignals, readTaskComments, tagsOfTask } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { TodoView } from '../../../core-wire/src/index.ts';
import type { TaskSpine } from '../commands/context.ts';
import { SELECT, summaryOf, type TaskRowRead } from './tasks.ts';

/** The reader's open tasks, soonest due first, then oldest. */
export async function readTodos(
  tx: TenantQuery,
  spine: TaskSpine,
  personId: string,
): Promise<readonly TodoView[]> {
  const rows = await tx.query<TaskRowRead>(
    `${SELECT}
      where r.business_id = $1 and r.record_type_id = $2 and r.deleted_at is null
        and r.uuid_2 = $3::uuid
        and coalesce(s.data ->> 'machine_category', '') not in ('completed', 'cancelled')
        and not (r.data ? 'archived_at')
      order by r.ts_1 nulls last, r.created_at, r.id`,
    [tx.businessId, spine.taskTypeId, personId],
  );
  const todos: TodoView[] = [];
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop -- one task's tags and thread at a time, in order
    todos.push({ ...summaryOf(row), ...(await extrasOf(tx, spine, row.id)) });
  }
  return todos;
}

/** One task's tags and the client messages owed a reply by the team. */
async function extrasOf(
  tx: TenantQuery,
  spine: TaskSpine,
  taskId: string,
): Promise<Pick<TodoView, 'tags' | 'waitingComments'>> {
  const comments =
    spine.taskCommentTypeId === undefined
      ? []
      : await readTaskComments(tx, spine.taskCommentTypeId, taskId);
  let waitingComments = 0;
  for (const signal of commentSignals(comments).values()) {
    if (signal === 'owed') waitingComments += 1;
  }
  return { tags: await tagsOfTask(tx, taskId), waitingComments };
}
