// SPDX-License-Identifier: AGPL-3.0-only
//
// A check the run performed, recorded under its worker lease (MP-6-1, CS-16.3).
//
// The caller is whoever holds the run's live lease: the agent its pickup
// delegated, or a person working their own pickup. The lease is locked and its
// holder, fence, liveness and the authority behind it are re-checked exactly as
// a heartbeat re-checks them (`lockOwnedLease`), so a caller holding no live
// lease writes nothing. The row takes its run, version and attempt from the
// lease's reservation, never from the body, and names the lease holder as the
// actor that performed the check: the provenance is the lease, not a claim.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/index.ts';
import { lockOwnedLease, type LeaseCaller } from './heartbeat.ts';
import { LEASE_FIXES } from './lease-ownership.ts';
import { only } from './only.ts';
import type { RuntimeResult } from './refusals.ts';

export const CHECK_OUTCOMES = ['passed', 'failed', 'inconclusive'] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

export type CheckRequest = LeaseCaller & {
  readonly name: string;
  readonly outcome: CheckOutcome;
  readonly note: string | null;
};

export interface RecordedCheck {
  readonly checkId: string;
  readonly taskId: string;
  readonly versionId: string;
  readonly runId: string;
}

export async function recordCheck(
  tx: TenantQuery,
  request: CheckRequest,
): Promise<RuntimeResult<RecordedCheck>> {
  const owned = await lockOwnedLease(tx, request, LEASE_FIXES.check);
  if (!owned.ok) return owned;
  const checkId = randomUUID();
  const written = await tx.query<{
    readonly task_id: string;
    readonly version_id: string;
    readonly run_id: string;
  }>(
    `insert into public.run_checks
       (business_id, id, task_id, run_id, version_id, lease_id, attempt_id, actor_id,
        fence, name, outcome, note, created_at)
     select l.business_id, $3, l.task_id, run.id, run.version_id, l.id, att.id,
            l.holder_actor_id, l.fence, $4, $5, $6, $7::timestamptz
       from public.leases l
       join public.reservations res
         on res.business_id = l.business_id and res.lease_id = l.id
       join public.planned_runs run
         on run.business_id = res.business_id and run.id = res.run_id
       join public.attempts att
         on att.business_id = res.business_id and att.reservation_id = res.id
      where l.business_id = $1 and l.id = $2
     returning task_id, version_id, run_id`,
    [
      tx.businessId,
      request.leaseId,
      checkId,
      request.name,
      request.outcome,
      request.note,
      owned.value.lockedAt,
    ],
  );
  const row = only(written, 'recordCheck: the live lease re-checked above, and its attempt');
  return {
    ok: true,
    value: { checkId, taskId: row.task_id, versionId: row.version_id, runId: row.run_id },
  };
}
