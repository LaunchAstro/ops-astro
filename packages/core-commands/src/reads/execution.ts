// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.execution`: the task's view of its runs (specification 14.4 item 5).
// Every run naming the task is reported on its own, never merged or narrowed
// to a current one, with a page of `run_events` after the caller's cursor.
//
// `reads/dispatch.ts` asks the grant at the task's record scope first, so there
// is no denied branch here to answer with an empty list. Of the six read
// outcomes this body carries `ready`, `no-run` and `stale` (a cursor past the
// stream's end, where `ready` would claim the caller is up to date); `denied`
// and `unavailable` are refusals and faults, and `loading` is the client's.

import type { TenantQuery } from '../../../core-records/src/index.ts';

/** The most events one read returns. `next` is the handle for the rest. */
export const EXECUTION_PAGE = 200;

export interface ExecutionRun {
  readonly runId: string;
  readonly lineageId: string;
  readonly versionId: string;
  readonly state: string;
  /** Null for a run planned before 0032, where the revision was never recorded. */
  readonly taskRevisionAtRequest: number | null;
  readonly createdAt: string;
}

export interface ExecutionEvent {
  readonly eventId: string;
  readonly runId: string;
  /** The task-wide order, across its runs. The cursor is one of these. */
  readonly position: number;
  readonly kind: string;
  readonly leaseId: string;
  readonly attemptId: string;
  readonly actorId: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly at: string;
}

export interface TaskExecution {
  readonly outcome: 'ready' | 'no-run' | 'stale';
  readonly taskId: string;
  /** The highest position recorded on the task when this read ran; 0 for none. */
  readonly sourceRevision: number;
  /** Whether `events` reaches `sourceRevision`. */
  readonly complete: boolean;
  /** The cursor that retrieves what this page omitted, or null when nothing was. */
  readonly next: number | null;
  readonly runs: readonly ExecutionRun[];
  readonly events: readonly ExecutionEvent[];
}

export async function readTaskExecution(
  tx: TenantQuery,
  taskId: string,
  cursor: number,
): Promise<TaskExecution> {
  const { runs, sourceRevision, events } = await snapshot(tx, taskId, cursor);
  const last = events.at(-1)?.position ?? cursor;
  const complete = last >= sourceRevision;
  return {
    outcome: runs.length === 0 ? 'no-run' : cursor > sourceRevision ? 'stale' : 'ready',
    taskId,
    sourceRevision,
    complete,
    next: complete ? null : last,
    runs,
    events,
  };
}

/** A timestamp in the shape `Date.toISOString` gives, formatted by the server. */
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * The runs, the event head and one page of events, read by one statement so
 * all three come from one snapshot: separate reads could see a successor's
 * events without its run. Counters come back as
 * `float8`, exact to 2^53 as a JS number is, so the rows need no mapping.
 */
async function snapshot(
  tx: TenantQuery,
  taskId: string,
  cursor: number,
): Promise<{
  readonly runs: readonly ExecutionRun[];
  readonly sourceRevision: number;
  readonly events: readonly ExecutionEvent[];
}> {
  const rows = await tx.query<{
    readonly runs: readonly ExecutionRun[];
    readonly sourceRevision: number;
    readonly events: readonly ExecutionEvent[];
  }>(
    `with head as (
       select coalesce(max(position), 0) as n
         from public.run_events where business_id = $1 and task_id = $2
     ), page as (
       select * from public.run_events
        where business_id = $1 and task_id = $2
          and position > $3 and position <= (select n from head)
        order by position limit $4
     )
     select (select n from head)::float8 as "sourceRevision",
            coalesce((select json_agg(json_build_object(
                'runId', id, 'lineageId', lineage_id, 'versionId', version_id, 'state', state,
                'taskRevisionAtRequest', task_revision_at_request::float8,
                'createdAt', to_char(created_at at time zone 'UTC', ${ISO}))
              order by created_at, id)
              from public.planned_runs where business_id = $1 and task_id = $2), '[]') as runs,
            coalesce((select json_agg(json_build_object(
                'eventId', id, 'runId', run_id, 'position', position::float8, 'kind', kind,
                'leaseId', lease_id, 'attemptId', attempt_id, 'actorId', actor_id,
                'detail', detail, 'at', to_char(created_at at time zone 'UTC', ${ISO}))
              order by position)
              from page), '[]') as events`,
    [tx.businessId, taskId, cursor, EXECUTION_PAGE],
  );
  const [row] = rows;
  if (row === undefined) throw new Error('task.execution: the snapshot returned no row');
  return row;
}
