// SPDX-License-Identifier: AGPL-3.0-only
//
// T3e1: a drop, and the work coming back from it.
//
// Work that stops because something failed under it is a drop, never a
// person's cancellation (docs/decisions/execution.md, C117 to C124). There are
// three causes, each kept apart so the root cause stays diagnosable, and each
// names whose fault it was:
//   - `provider_unavailable`: the provider did not answer (the provider's);
//   - `connection_lost`: the connection to it was lost (the network's);
//   - `worker_lost`: our worker went silent and its lease ran out (ours).
// A worker reports the first two by handing back `dropped` (`handback.ts`);
// nothing reports the third, so the sweep names it when the lease's own
// deadline passes (`sweepLostWorkers` below, the pass's sweep). A silent run is
// running until then.
//
// The caller has classified the hold under its locks. Here the cause is
// written once, `dropped` is appended to the run's progress, and a person is
// told through the outage report the drop joins (T3e2, `outage.ts`). Then the work comes back by itself, because nobody decided to stop it:
// an unmarked step did nothing, so it is reserved again as a new attempt on
// the same run and step, through `reserve`'s envelope and cap checks and only
// on a live lineage whose approval is current (T3d1's `resume`). The run's
// progress carries on from its last event, never from zero. A marked step may
// have acted: its hold stays whole and unknown with the cause beside it, and
// only the reconciliation pass's proof resumes it (T3d1). A cancellation never
// comes here, and its lineage is terminal, so nothing it stopped returns.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { LockSet } from '../locks.ts';
import { appendRunEvent } from '../run-events.ts';
import type { Classification } from './classifier.ts';
import { DROP_FAULT, joinOutage, type DropCause } from './outage.ts';
import { resume, UNKNOWN_SELECT, type Unknown } from './reconcile.ts';
import { sweepExpiredLeases } from './sweep.ts';

export { DROP_FAULT, type DropCause };

/** The causes a worker may report of itself. It cannot report its own loss. */
export const REPORTED_DROP_CAUSES: readonly DropCause[] = [
  'provider_unavailable',
  'connection_lost',
];

/**
 * Record the drop of `attemptId` and bring its work back where that is safe.
 * `retire` revokes the delegation the dropped worker held, so a worker woken
 * later is refused and its purpose is free for the next pickup; a hand-back
 * has settled that delegation already. Replayed, it writes nothing.
 */
export async function recordDrop(
  tx: TenantQuery,
  drop: {
    readonly attemptId: string;
    readonly cause: DropCause;
    readonly retire: boolean;
    readonly locks: LockSet;
  },
): Promise<string> {
  const [row] = await tx.query<Unknown>(
    `${UNKNOWN_SELECT} where att.business_id = $1 and att.id = $2`,
    [tx.businessId, drop.attemptId],
  );
  if (row === undefined) return 'no such attempt in this business';
  drop.locks.require('task', row.task_id);
  const [marked] = await tx.query<{ readonly state: string }>(
    `update public.attempts
        set drop_cause = $3, state = case when state = 'abandoned' then 'dropped' else state end
      where business_id = $1 and id = $2 and drop_cause is null
        and state in ('abandoned', 'liability_unknown')
      returning state`,
    [tx.businessId, drop.attemptId, drop.cause],
  );
  if (marked === undefined || row.lease_id === null || row.holder_actor_id === null) {
    return 'nothing to drop: already recorded, or not a stopped attempt';
  }
  const event = {
    taskId: row.task_id,
    runId: row.run_id,
    leaseId: row.lease_id,
    actorId: row.holder_actor_id,
  };
  await appendRunEvent(
    tx,
    {
      ...event,
      kind: 'dropped',
      attemptId: drop.attemptId,
      detail: { cause: drop.cause, fault: DROP_FAULT[drop.cause], attemptState: marked.state },
    },
    drop.locks,
  );
  // A person is told once per outage, not once per run (T3e2, `outage.ts`).
  const outage = {
    cause: drop.cause,
    attemptId: drop.attemptId,
    runId: row.run_id,
    taskId: row.task_id,
  };
  if (marked.state !== 'dropped') {
    await joinOutage(tx, { ...outage, reactivated: false });
    return 'dropped after its dispatch mark: the whole hold stays unknown for the reconciliation pass';
  }
  const resumed = await resume(
    tx,
    { ...row, delegation_id: drop.retire ? row.delegation_id : null },
    false,
  );
  const [next] = await tx.query<{ readonly id: string; readonly after: string }>(
    `select att.id,
            (select max(position) from public.run_events
              where business_id = $1 and task_id = $4)::text as after
       from public.attempts att
       join public.reservations res on res.business_id = att.business_id and res.id = att.reservation_id
      where att.business_id = $1 and res.run_id = $2 and att.step_id = $3 and att.state = 'reserved'
        and res.state = 'held' and res.lease_id is null`,
    [tx.businessId, row.run_id, row.step_id, row.task_id],
  );
  await joinOutage(tx, { ...outage, reactivated: next !== undefined });
  if (next === undefined) return `dropped and ${resumed}`;
  await appendRunEvent(
    tx,
    {
      ...event,
      kind: 'reactivated',
      attemptId: next.id,
      detail: { after: Number(next.after), attemptId: next.id },
    },
    drop.locks,
  );
  return `dropped and reactivated as attempt ${next.id}`;
}

/**
 * The pass's sweep with its drop step: a lease that ran out with nothing
 * reported is our worker lost, recorded under the sweep's own locks.
 */
export async function sweepLostWorkers(tx: TenantQuery): Promise<readonly Classification[]> {
  return await sweepExpiredLeases(tx, async (found, locks) => {
    for (const row of found) {
      // Sequential: each reactivation reserves against the envelope the next may share.
      // eslint-disable-next-line no-await-in-loop
      const [attempt] = await tx.query<{ readonly id: string }>(
        'select id from public.attempts where business_id = $1 and reservation_id = $2',
        [tx.businessId, row.reservation_id],
      );
      if (attempt === undefined) continue;
      // eslint-disable-next-line no-await-in-loop
      await recordDrop(tx, { attemptId: attempt.id, cause: 'worker_lost', retire: true, locks });
    }
  });
}
