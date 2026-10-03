// SPDX-License-Identifier: AGPL-3.0-only
//
// The AW-12 runtime authorities' reads and bodies (`aw-12-authorities.test.ts`),
// on AW-10's broker world: what product rows hold, the queue's entry for a
// task, a worker's drop, and the calls on a lease. Kept apart so the suite
// stays under the per-file cap.

import { randomUUID } from 'node:crypto';
import { s } from '../broker/aw-10-world.ts';
import {
  appliedDetail,
  asAgent,
  handbackBody,
  rows,
  type Detail,
  type Work,
} from '../runtime/schedules-harness.ts';

/** Every row of every table in the product's schema that holds `canary`, as `table: count`. */
export async function holding(canary: string): Promise<string[]> {
  const tables = await rows<{ name: string }>(
    s,
    `select format('%I.%I', schemaname, tablename) as name from pg_tables
      where schemaname = 'public' order by 1`,
    [],
  );
  const found: string[] = [];
  for (const { name } of tables) {
    // eslint-disable-next-line no-await-in-loop -- one table at a time
    const [hit] = await rows<{ n: string }>(
      s,
      `select count(*)::text as n from ${name} t where t::text like $1`,
      [`%${canary}%`],
    );
    if (hit !== undefined && hit.n !== '0') found.push(`${name}: ${hit.n}`);
  }
  return found;
}

/** The task's row, its versions, its history and its runs' events: what the framework must not own. */
export const taskState = async (taskId: string): Promise<readonly unknown[]> =>
  await rows(
    s,
    `select (select t::text from public.records t where business_id = $1 and id = $2) as task,
            (select string_agg(v::text, ',' order by v.version) from public.proposal_versions v
               join public.proposal_lineages l on l.business_id = v.business_id and l.id = v.lineage_id
              where v.business_id = $1 and l.task_id = $2) as versions,
            (select string_agg(a.command || ':' || a.outcome, ',' order by a.seq)
               from public.audit_events a where business_id = $1 and subject_record_id = $2) as history,
            (select string_agg(e.kind, ',' order by e.position)
               from public.run_events e where business_id = $1 and task_id = $2) as events`,
    [s.business, taskId],
  );

export const queued = async (taskId: string): Promise<Detail | undefined> => {
  const queue = appliedDetail(
    await asAgent(s, { command: 'task.queue', operationId: randomUUID() }),
    'task.queue',
  )['queue'] as readonly Detail[];
  return queue.find((entry) => entry['taskId'] === taskId);
};

/** A drop the worker reports of itself, `provider_unavailable`: the product's own retry. */
export const dropBody = (work: Work): Detail => ({
  ...handbackBody(work.picked),
  outcome: 'dropped',
  report: { dropCause: 'provider_unavailable' },
});

/** The model calls on the work's lease: state, refusal and whether each was sent. */
export const callsOn = async (work: Work): Promise<readonly unknown[]> =>
  await rows(
    s,
    `select state, refusal_code, started_at is not null as sent from public.model_calls
      where business_id = $1 and lease_id = $2 order by accepted_at, id`,
    [s.business, work.picked['leaseId']],
  );

/** The run, its steps and its events, as text. */
export const runRecord = async (runId: unknown): Promise<readonly unknown[]> =>
  await rows(
    s,
    `select (select t::text from public.planned_runs t where business_id = $1 and id = $2) as run,
            (select string_agg(t::text, ',' order by t.id) from public.planned_steps t
              where business_id = $1 and run_id = $2) as steps,
            (select string_agg(t::text, ',' order by t.position) from public.run_events t
              where business_id = $1 and run_id = $2) as events`,
    [s.business, runId],
  );
