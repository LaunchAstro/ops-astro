// SPDX-License-Identifier: AGPL-3.0-only
// Shared open-task evidence for the compact and board readers.

import {
  commentSignals,
  readTaskCommentEvidence,
  tagsOfTasks,
} from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { TodoView } from '../../../core-wire/src/index.ts';
import type { TaskSpine } from '../commands/context.ts';

export const OPEN_TODO_SQL = `coalesce(s.data ->> 'machine_category', '') not in ('completed', 'cancelled') and not (r.data ? 'archived_at')`;

/** Whose open tasks: one person's (the reader's own, or a teammate's), or a client's. */
export type TodoScope =
  | { readonly person: string; readonly client?: string }
  | { readonly client: string; readonly person?: string };

/**
 * Whose move each served task is, by the task page's rule (DP-14): Review
 * while a gate on one of its versions is pending and not expired, Agent while
 * a reservation on one of its runs holds a live lease; a task with neither is
 * absent, so Team.
 */
export async function movesOf(
  tx: TenantQuery,
  taskIds: readonly string[],
): Promise<ReadonlyMap<string, TodoView['whoseMove']>> {
  if (taskIds.length === 0) return new Map();
  const rows = await tx.query<{
    readonly task_id: string;
    readonly gated: boolean;
    readonly leased: boolean;
  }>(
    `select lin.task_id::text as task_id,
            bool_or(exists (
              select 1 from public.proposal_versions ver
                join public.gates g on g.business_id = ver.business_id and g.version_id = ver.id
               where ver.business_id = lin.business_id and ver.lineage_id = lin.id
                 and g.state = 'pending' and g.expires_at > now())) as gated,
            bool_or(exists (
              select 1 from public.planned_runs run
                join public.reservations res
                  on res.business_id = run.business_id and res.run_id = run.id
                join public.leases lease
                  on lease.business_id = res.business_id and lease.id = res.lease_id
               where run.business_id = lin.business_id and run.lineage_id = lin.id
                 and lease.state = 'live')) as leased
       from public.proposal_lineages lin
      where lin.business_id = $1 and lin.task_id = any($2::uuid[])
      group by lin.task_id`,
    [tx.businessId, taskIds],
  );
  const moves = new Map<string, TodoView['whoseMove']>();
  for (const row of rows) {
    if (row.gated) moves.set(row.task_id, 'Review');
    else if (row.leased) moves.set(row.task_id, 'Agent');
  }
  return moves;
}

/** Batched tags and canonical client reply signals for the admitted rows. */
export async function extrasForTasks(
  tx: TenantQuery,
  spine: TaskSpine,
  taskIds: readonly string[],
): Promise<ReadonlyMap<string, Pick<TodoView, 'tags' | 'waitingComments'>>> {
  const comments =
    spine.taskCommentTypeId === undefined
      ? []
      : await readTaskCommentEvidence(tx, spine.taskCommentTypeId, taskIds);
  const tags = await tagsOfTasks(tx, taskIds);
  const threads = new Map<string, (typeof comments)[number][]>();
  for (const comment of comments) {
    const thread = threads.get(comment.taskId) ?? [];
    thread.push(comment);
    threads.set(comment.taskId, thread);
  }
  return new Map(
    taskIds.map((id) => [
      id,
      {
        tags: tags.get(id) ?? [],
        waitingComments: [...commentSignals(threads.get(id) ?? []).values()].filter(
          (signal) => signal === 'owed',
        ).length,
      },
    ]),
  );
}
