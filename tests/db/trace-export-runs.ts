// SPDX-License-Identifier: AGPL-3.0-only
//
// The runs the trace export login test exports: a replay-fake run handed back
// with its comment and report planted, its one replay call, and the run's
// state and the business's gaps as the test reads them.

import { randomUUID } from 'node:crypto';
import {
  appliedDetail,
  asAgent,
  asPerson,
  handbackBody,
  liveWork,
  revisionOf,
  rows,
  type Schedules,
} from '../runtime/schedules-harness.ts';

async function replayCall(s: Schedules, leaseId: unknown): Promise<void> {
  await rows(
    s,
    `insert into public.model_calls
      (business_id, id, run_id, step_id, lease_id, version_id, reservation_id,
       operation_key, route_key, credential_kind, state, reserved_minor, actual_minor,
       accepted_at, ended_at)
     select l.business_id, $2, l.run_id, st.id, l.id, r.version_id, r.id,
            'scripted_replay', 'replay', 'replay', 'settled', 1, 1, now(), now()
       from public.leases l
       join public.reservations r on r.business_id = l.business_id and r.id = l.reservation_id
       join public.planned_steps st on st.business_id = l.business_id and st.run_id = l.run_id
      where l.business_id = $1 and l.id = $3 order by st.ordinal limit 1`,
    [s.business, randomUUID(), leaseId],
  );
}

/** A replay-fake run handed back, its title, comment and report planted with content. */
export async function plantedRun(
  s: Schedules,
  planted: string,
): Promise<Awaited<ReturnType<typeof liveWork>>> {
  const work = await liveWork(s, `trace-login ${planted}`, 1_000);
  appliedDetail(
    await asPerson(s, {
      command: 'task.comment',
      operationId: randomUUID(),
      recordId: work.taskId,
      expectedRevision: await revisionOf(s, work.taskId),
      body: planted,
      audience: 'internal',
    }),
    'task.comment',
  );
  await replayCall(s, work.picked['leaseId']);
  appliedDetail(
    await asAgent(
      s,
      { ...handbackBody(work.picked), report: { summary: planted } },
      String(work.picked['credential']),
    ),
    'task.handback',
  );
  return work;
}

export async function runState(s: Schedules, runId: unknown): Promise<string | undefined> {
  const [row] = await rows<{ state: string }>(
    s,
    'select state from public.planned_runs where business_id = $1 and id = $2',
    [s.business, runId],
  );
  return row?.state;
}

export async function gaps(s: Schedules): Promise<number> {
  const [row] = await rows<{ n: number }>(
    s,
    'select count(*)::int as n from public.trace_export_gaps where business_id = $1',
    [s.business],
  );
  return row?.n ?? -1;
}
