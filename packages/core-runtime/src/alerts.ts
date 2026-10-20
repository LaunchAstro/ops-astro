// SPDX-License-Identifier: AGPL-3.0-only
//
// T2h: the alert record's read. Its writer, `raiseAlert`, and the rule of when one is raised
// are in `core-records/src/tasks/alerts.ts`, below the broker and the runtime both.

import type { AlertKind, TenantQuery, WaitingReason } from '../../core-records/src/index.ts';

export { raiseAlert, type Raised } from '../../core-records/src/index.ts';

export interface Alert {
  readonly id: string;
  readonly taskId: string;
  readonly kind: AlertKind;
  readonly waitingReason: WaitingReason | null;
  /** The attempt or lineage whose transition raised it. */
  readonly causeId: string;
  readonly raisedAt: string;
}

/** A task's alerts, or every live task's when `taskId` is absent; newest first. */
export async function readAlerts(tx: TenantQuery, taskId?: string): Promise<readonly Alert[]> {
  const rows = await tx.query<{
    readonly id: string;
    readonly task_id: string;
    readonly kind: AlertKind;
    readonly waiting_reason: WaitingReason | null;
    readonly cause_id: string;
    readonly raised_at: Date;
  }>(
    `select a.id, a.task_id, a.kind, a.waiting_reason, a.cause_id, a.raised_at
       from public.alerts a
       join public.records task on task.business_id = a.business_id and task.id = a.task_id
                               and task.deleted_at is null
      where a.business_id = $1 and ($2::uuid is null or a.task_id = $2::uuid)
      order by a.raised_at desc, a.id`,
    [tx.businessId, taskId ?? null],
  );
  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    waitingReason: row.waiting_reason,
    causeId: row.cause_id,
    raisedAt: row.raised_at.toISOString(),
  }));
}
