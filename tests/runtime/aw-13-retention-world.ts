// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13 retention's helpers over the AW-13 world: age a run's events past the
// window (run events are append only, so the ageing runs as the admin with
// triggers off for its one statement), read a business's recorded passes,
// list the trace ids the target was asked to delete, and read or append a
// run's events.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { derivedId } from '../../packages/core-runtime/src/index.ts';
import { rows, type Schedules } from './schedules-harness.ts';
import { t, TRACE_KEY } from './aw-13-world.ts';

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

/** The run's event ids, in the export's order. */
export async function eventIds(runId: string): Promise<string[]> {
  return (
    await rows<{ id: string }>(
      t.alpha,
      'select id from public.run_events where business_id = $1 and run_id = $2 order by tx, id',
      [t.alpha.business, runId],
    )
  ).map((row) => row.id);
}

/** Appends `count` events to the run, each after its last. */
export async function append(runId: string, count: number): Promise<void> {
  const s = t.alpha;
  const [last] = await rows<{
    taskId: string;
    position: string;
    leaseId: string;
    attemptId: string;
    actorId: string;
  }>(
    s,
    `select task_id as "taskId", position::text as position, lease_id as "leaseId",
            attempt_id as "attemptId", actor_id as "actorId"
       from public.run_events ev where business_id = $1 and run_id = $2
      order by ev.position desc limit 1`,
    [s.business, runId],
  );
  if (last === undefined) throw new Error('no event to follow');
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (let n = 1; n <= count; n += 1) {
      // eslint-disable-next-line no-await-in-loop -- one event after another, in position order
      await tx.query(
        `insert into public.run_events
           (business_id, id, run_id, task_id, position, kind, lease_id, attempt_id, actor_id, detail)
         values ($1, $2, $3, $4, $5, 'claimed', $6, $7, $8, '{}'::jsonb)`,
        [
          s.business,
          randomUUID(),
          runId,
          last.taskId,
          Number(last.position) + n,
          last.leaseId,
          last.attemptId,
          last.actorId,
        ],
      );
    }
  });
}

/** The span of the run's latest handback, as the export derives it. */
export async function handbackSpan(runId: string): Promise<string> {
  const [row] = await rows<{ id: string }>(
    t.alpha,
    `select id from public.run_events
      where business_id = $1 and run_id = $2 and kind = 'handed_back'
      order by tx desc, id desc limit 1`,
    [t.alpha.business, runId],
  );
  if (row === undefined) throw new Error('the run has no handback');
  return derivedId(TRACE_KEY, ['span', t.alpha.business, row.id], 16);
}

/** A committed test's body, by its quoted title, for a meta test to run as it stands. */
export function committedBody(file: string, title: string): string {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const at = source.indexOf(title);
  const start = source.indexOf('async () => {', at);
  const end = source.indexOf('\n  },\n);', start);
  if (at < 0 || start < 0 || end < 0) throw new Error(`the committed test was not found: ${file}`);
  return source.slice(start, end) + '\n}';
}
