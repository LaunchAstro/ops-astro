// SPDX-License-Identifier: AGPL-3.0-only
//
// The run's task, first in a model call's lock order: its client link (C60)
// and what a bound field reads of it as a source (S3).

import { slotOf, TASK_SPINE, type TenantQuery } from '../../core-records/src/index.ts';
import { LEAVES_ROW_DATA, type TaskSource } from './broker-sources.ts';

/** The spine's client slot: the party link `task.set_party` writes. */
const CLIENT_SLOT = slotOf(TASK_SPINE, 'client');

/** The lease's run's task. */
const TASK_OF_LEASE = `
       from public.leases l
       join public.planned_runs run on run.business_id = l.business_id and run.id = l.run_id
       join public.records t on t.business_id = run.business_id and t.id = run.task_id
      where l.business_id = $1 and l.id = $2`;

/** The run's task, taken `for share` before anything of it is read. */
const LOCK_TASK = `select t.id ${TASK_OF_LEASE} for share of t`;

/**
 * What S3 reads of the task (`broker-sources.ts`), in a statement of its own
 * after the lock: a statement that waits on the lock rereads the task's row
 * but keeps its earlier view of the operations, so an edit committed during
 * the wait would be read without the write that made it.
 */
const READ_TASK = `select t.id::text as id, run.id::text as run_id, t.${CLIENT_SLOT}::text as client,
            t.deleted_at is null as live, t.data, exists (
              select 1 from public.operations o
                join public.actors a on a.business_id = o.business_id and a.id = o.actor_id
               where o.business_id = t.business_id and o.record_id = t.id
                 and o.outcome = 'applied' and a.kind <> 'person'
                 and o.command <> all($3::text[])) as others_wrote ${TASK_OF_LEASE}`;

/**
 * The run's task, first in the lock order (`task` comes before `lease`), held
 * `for share` so a `task.set_party` cannot move its client while the call is
 * decided, and answering the task's client link (C60) and what a bound
 * field reads of it (S3): a link or an edit in flight is waited on, never
 * missed. The lease names the run and the run its
 * task, read here before the lease's own lock; the run's task is fixed once
 * written (the application may update a run's state only, 0086), and the
 * lease's run is compared again under the lease's lock (`lockFacts`).
 * Unknown to this business answers nothing, refused as a made-up lease is.
 */
export async function lockTask(
  tx: TenantQuery,
  leaseId: string,
): Promise<
  | { readonly runId: string; readonly clientId: string | null; readonly source: TaskSource }
  | undefined
> {
  await tx.query(LOCK_TASK, [tx.businessId, leaseId]);
  const [task] = await tx.query<{
    id: string;
    run_id: string;
    client: string | null;
    live: boolean;
    data: Record<string, unknown>;
    others_wrote: boolean;
  }>(READ_TASK, [tx.businessId, leaseId, LEAVES_ROW_DATA]);
  if (task === undefined) return undefined;
  const entered = task.data['source'];
  return {
    runId: task.run_id,
    clientId: task.client,
    source: {
      id: task.id,
      live: task.live,
      entered: typeof entered === 'string' ? entered : null,
      othersWrote: task.others_wrote,
      data: task.data,
    },
  };
}
