// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13 retention's helpers over the AW-13 world: age a run's events past the
// window (run events are append only, so the ageing runs as the admin with
// triggers off for its one statement), read a business's recorded passes, and
// list the trace ids the target was asked to delete.

import { rows, type Schedules } from './schedules-harness.ts';
import { t } from './aw-13-world.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Move every event of `runId` back by `days`. */
export async function age(runId: string, days: number): Promise<void> {
  if (!UUID.test(runId) || !Number.isInteger(days)) throw new Error('age: not a run id or days');
  await t.alpha.db.admin.execute(
    `do $$ begin
       set local session_replication_role = replica;
       update public.run_events set created_at = created_at - make_interval(days => ${String(days)})
        where run_id = '${runId}';
     end $$`,
  );
}

export interface Batch {
  readonly window_days: number;
  readonly runs: number;
  readonly expired_run_ids: readonly string[];
  readonly code: string | null;
}

/** A business's recorded passes, oldest first. */
export async function batchesOf(s: Schedules): Promise<readonly Batch[]> {
  return await rows<Batch>(
    t.alpha,
    `select window_days, runs, expired_run_ids::text[] as expired_run_ids, code
       from public.trace_expiry_batches where business_id = $1 order by recorded_at, id`,
    [s.business],
  );
}

/** Every trace id the target was asked to delete since its lists were last cleared. */
export function deletedIds(): readonly string[] {
  return t.target.received.flatMap((body, at) =>
    t.target.methods[at] === 'DELETE' ? (JSON.parse(body) as { traceIds: string[] }).traceIds : [],
  );
}

/** Clear what the target saw, every list together so their positions stay aligned. */
export function clearSeen(): void {
  for (const list of [
    t.target.received,
    t.target.paths,
    t.target.authorizations,
    t.target.methods,
    t.target.ingestion,
  ]) {
    list.length = 0;
  }
}
