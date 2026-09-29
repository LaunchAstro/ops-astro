// SPDX-License-Identifier: AGPL-3.0-only
//
// T2h: the alert record. A transition into settled, failed or cancelled, or
// into a wait only a person can end, raises one alert on its task, written by
// the caller inside the transaction that made the transition, so the two
// commit together or not at all. Progress (a pickup, a dispatch, the effect,
// an unpriced report) is not a transition and raises none.
//
// The raise points are T2d's settlement (`budget.ts`), hand-back's settlement
// (`handback.ts`) and cancellation (`recovery/lease-retirement.ts`). A pending
// gate a proposal opens is the gate engine's (`propose.ts`), and raising there
// is a gate-engine touch this part does not make.
//
// One alert per cause and kind (`alerts_one_per_transition`, 0036); a replayed
// transition's insert does nothing. Nothing delivers an alert: the task page
// and the queue read show them to the team (C12-6).

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/index.ts';

export type AlertKind = 'settled' | 'failed' | 'cancelled' | 'awaiting_person';

/** Why a person's move is the next one, on an `awaiting_person` alert. */
export type WaitingReason = 'needs_approval' | 'liability_unknown' | 'quarantined';

export type Raised =
  | { readonly kind: Exclude<AlertKind, 'awaiting_person'> }
  | { readonly kind: 'awaiting_person'; readonly waitingReason: WaitingReason };

export interface Alert {
  readonly id: string;
  readonly taskId: string;
  readonly kind: AlertKind;
  readonly waitingReason: WaitingReason | null;
  /** The attempt or lineage whose transition raised it. */
  readonly causeId: string;
  readonly raisedAt: string;
}

export async function raiseAlert(
  tx: TenantQuery,
  of: { readonly taskId: string; readonly causeId: string; readonly raised: Raised },
): Promise<void> {
  await tx.query(
    `insert into public.alerts (business_id, id, task_id, kind, waiting_reason, cause_id)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (business_id, cause_id, kind) do nothing`,
    [
      tx.businessId,
      randomUUID(),
      of.taskId,
      of.raised.kind,
      of.raised.kind === 'awaiting_person' ? of.raised.waitingReason : null,
      of.causeId,
    ],
  );
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
