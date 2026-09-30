// SPDX-License-Identifier: AGPL-3.0-only
//
// T2a: the one writer of a run's progress record.
//
// Pickup, hand-back and a drop (T3e1) call it as a named step inside their
// own transaction, so an event commits with its transition or not at all. A
// refused call returns before this step and keeps only its audit event:
// `run_events` is what happened to the run (the coordinator's ruling on T2a's
// open question).
// The task lock is required, not taken: the position is read and written
// under it, and a caller without it is a bug (`LockSet.require`).

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/index.ts';
import type { LockSet } from './locks.ts';

export type RunEventKind =
  | 'claimed'
  | 'handed_back'
  | 'dropped'
  | 'reactivated'
  // AW-11: a helper handed part of the work, and its result merged back.
  | 'delegated'
  | 'child_handed_back';

export interface RunEvent {
  readonly kind: RunEventKind;
  readonly taskId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly attemptId: string;
  /** The actor whose call this was: the lease's holder. */
  readonly actorId: string;
  /** Handles and facts only. Never a report body or a credential. */
  readonly detail: Readonly<Record<string, string | number | null>>;
}

/** Append one event at the task's next position. */
export async function appendRunEvent(
  tx: TenantQuery,
  event: RunEvent,
  locks: LockSet,
): Promise<void> {
  locks.require('task', event.taskId);
  await tx.query(
    `insert into public.run_events
       (business_id, id, run_id, task_id, position, kind, lease_id, attempt_id, actor_id, detail)
     select $1, $2, $3, $4, coalesce(max(position), 0) + 1, $5, $6, $7, $8, $9::text::jsonb
       from public.run_events where business_id = $1 and task_id = $4`,
    [
      tx.businessId,
      randomUUID(),
      event.runId,
      event.taskId,
      event.kind,
      event.leaseId,
      event.attemptId,
      event.actorId,
      JSON.stringify(event.detail),
    ],
  );
}
