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
  const runs = await runsOf(tx, taskId);
  const head = await tx.query<{ readonly n: string }>(
    `select coalesce(max(position), 0)::text as n
       from public.run_events where business_id = $1 and task_id = $2`,
    [tx.businessId, taskId],
  );
  const sourceRevision = Number(head[0]?.n ?? 0);
  const events = await eventsAfter(tx, taskId, cursor, sourceRevision);
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
 * Every run naming the task, oldest first, each on its own. Counters come back
 * as `float8`, exact to 2^53 as a JS number is, so the rows need no mapping.
 */
async function runsOf(tx: TenantQuery, taskId: string): Promise<readonly ExecutionRun[]> {
  return await tx.query<ExecutionRun>(
    `select id as "runId", lineage_id as "lineageId", version_id as "versionId", state,
            task_revision_at_request::float8 as "taskRevisionAtRequest",
            to_char(created_at at time zone 'UTC', ${ISO}) as "createdAt"
       from public.planned_runs where business_id = $1 and task_id = $2
      order by created_at, id`,
    [tx.businessId, taskId],
  );
}

/** One page of the task's events after `cursor`, bounded by the head read above. */
async function eventsAfter(
  tx: TenantQuery,
  taskId: string,
  cursor: number,
  sourceRevision: number,
): Promise<readonly ExecutionEvent[]> {
  return await tx.query<ExecutionEvent>(
    `select id as "eventId", run_id as "runId", position::float8 as position, kind,
            lease_id as "leaseId", attempt_id as "attemptId", actor_id as "actorId", detail,
            to_char(created_at at time zone 'UTC', ${ISO}) as at
       from public.run_events
      where business_id = $1 and task_id = $2 and position > $3 and position <= $4
      order by position limit $5`,
    [tx.businessId, taskId, cursor, sourceRevision, EXECUTION_PAGE],
  );
}
