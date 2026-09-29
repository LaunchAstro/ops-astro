// SPDX-License-Identifier: AGPL-3.0-only
//
// The T3e1 drops suite's work and reads (`t3e1-drops.test.ts`): one approved
// step picked up, and the attempts, run events, alerts, outage reports and
// digest a drop may move. Kept apart so the suite stays under the per-file cap.

import { randomUUID } from 'node:crypto';
import { sweepLostWorkers } from '../../packages/core-runtime/src/index.ts';
import {
  appliedDetail,
  approve,
  asPerson,
  createTask,
  freshPurpose,
  pickup,
  proposeBody,
  revisionOf,
  rows,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

export interface Picked {
  readonly taskId: string;
  readonly decision: Detail;
  readonly picked: Detail;
  readonly credential: string;
}

export const work = async (on: Schedules, leaseSeconds = 600): Promise<Picked> => {
  const taskId = await createTask(on, `t3e1 ${randomUUID()}`);
  const body = {
    ...proposeBody(taskId, await revisionOf(on, taskId), {
      purpose: freshPurpose(),
      maximumMinor: 2_500,
    }),
    step: { kind: 'synthetic_comment', payload: {} },
  };
  const proposal = appliedDetail(await asPerson(on, body), 'task.propose');
  const decision = await approve(on, proposal);
  const picked = await pickup(on, decision['reservationId'], leaseSeconds);
  return { taskId, decision, picked, credential: String(picked['credential']) };
};

interface AttemptRow {
  id: string;
  state: string;
  drop_cause: string | null;
  held: string;
}

export const attempts = async (on: Schedules, taskId: string): Promise<readonly AttemptRow[]> =>
  await rows<AttemptRow>(
    on,
    `select att.id, att.state, att.drop_cause, res.state as held
       from public.attempts att
       join public.reservations res on res.business_id = att.business_id and res.id = att.reservation_id
       join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
      where att.business_id = $1 and run.task_id = $2 order by att.created_at, att.id`,
    [on.business, taskId],
  );

interface EventRow {
  position: string;
  kind: string;
  run_id: string;
  detail: Record<string, unknown>;
}

export const events = async (on: Schedules, taskId: string): Promise<readonly EventRow[]> =>
  await rows<EventRow>(
    on,
    `select position::text, kind, run_id, detail from public.run_events
      where business_id = $1 and task_id = $2 order by position`,
    [on.business, taskId],
  );

export const alerts = async (on: Schedules, taskId: string): Promise<string[]> =>
  (
    await rows<{ kind: string }>(
      on,
      'select kind from public.alerts where business_id = $1 and task_id = $2 order by raised_at, id',
      [on.business, taskId],
    )
  ).map((row) => row.kind);

/** The outage reports that list this task's runs, by cause (T3e2). */
export const toldIn = async (on: Schedules, taskId: string): Promise<readonly string[]> =>
  (
    await rows<{ cause: string }>(
      on,
      `select r.cause from public.outage_runs o
         join public.outage_reports r on r.business_id = o.business_id and r.id = o.outage_id
        where o.business_id = $1 and o.task_id = $2`,
      [on.business, taskId],
    )
  ).map((row) => row.cause);

export const sweep = async (on: Schedules): ReturnType<typeof sweepLostWorkers> =>
  await on.db.app.withBusiness(on.business, async (tx) => await sweepLostWorkers(tx));

/** Everything the other business holds that a drop here could move. */
export const digest = async (on: Schedules): Promise<readonly unknown[]> =>
  await rows(
    on,
    `select (select count(*) from public.attempts where business_id = $1 and state = 'dropped') as dropped,
            (select md5(coalesce(string_agg(t::text, ',' order by t::text), '')) from public.attempts t where business_id = $1) as a,
            (select md5(coalesce(string_agg(t::text, ',' order by t::text), '')) from public.reservations t where business_id = $1) as r,
            (select md5(coalesce(string_agg(t::text, ',' order by t::text), '')) from public.run_events t where business_id = $1) as e,
            (select md5(coalesce(string_agg(t::text, ',' order by t::text), '')) from public.alerts t where business_id = $1) as al`,
    [on.business],
  );
