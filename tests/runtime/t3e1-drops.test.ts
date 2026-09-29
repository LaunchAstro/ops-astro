// SPDX-License-Identifier: AGPL-3.0-only
//
// T3e1: drop states, attribution and resume, in the runtime and the command
// layer. `drop_is_not_cancel`: each drop keeps its own cause and fault, the
// run's progress carries on from its last event rather than from zero, and
// the work is reserved again with a person told; a person's cancellation at
// the same point is never a drop and never comes back. A provider or
// connection drop is the worker's hand-back; a lost worker is a lease that ran
// out on its own clock (one second here, never a row write) and the sweep.
// The same drops from real process kills are in
// `tests/acceptance/drop-proofs.test.tsx`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { sweepExpiredLeases } from '../../packages/core-runtime/src/index.ts';
import {
  appliedDetail,
  approve,
  asAgent,
  asPerson,
  codeOf,
  createTask,
  freshPurpose,
  handbackBody,
  openSchedules,
  pickup,
  proposeBody,
  revisionOf,
  rows,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';
import { openSecond } from './t3b-harness.ts';

const url = databaseUrlFromEnvironment();

interface Picked {
  readonly taskId: string;
  readonly decision: Detail;
  readonly picked: Detail;
  readonly credential: string;
}

const work = async (on: Schedules, leaseSeconds = 600): Promise<Picked> => {
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

const attempts = async (on: Schedules, taskId: string) =>
  await rows<{ id: string; state: string; drop_cause: string | null; held: string }>(
    on,
    `select att.id, att.state, att.drop_cause, res.state as held
       from public.attempts att
       join public.reservations res on res.business_id = att.business_id and res.id = att.reservation_id
       join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
      where att.business_id = $1 and run.task_id = $2 order by att.created_at, att.id`,
    [on.business, taskId],
  );

const events = async (on: Schedules, taskId: string) =>
  await rows<{ position: string; kind: string; run_id: string; detail: Record<string, unknown> }>(
    on,
    `select position::text, kind, run_id, detail from public.run_events
      where business_id = $1 and task_id = $2 order by position`,
    [on.business, taskId],
  );

const alerts = async (on: Schedules, taskId: string) =>
  (
    await rows<{ kind: string }>(
      on,
      'select kind from public.alerts where business_id = $1 and task_id = $2 order by raised_at, id',
      [on.business, taskId],
    )
  ).map((row) => row.kind);

const sweep = async (on: Schedules) =>
  await on.db.app.withBusiness(on.business, async (tx) => await sweepExpiredLeases(tx));

/** Everything the other business holds that a drop here could move. */
const digest = async (on: Schedules) =>
  await rows(
    on,
    `select (select count(*) from public.attempts where business_id = $1 and state = 'dropped') as dropped,
            (select md5(coalesce(string_agg(t::text, ',' order by t::text), '')) from public.attempts t where business_id = $1) as a,
            (select md5(coalesce(string_agg(t::text, ',' order by t::text), '')) from public.reservations t where business_id = $1) as r,
            (select md5(coalesce(string_agg(t::text, ',' order by t::text), '')) from public.run_events t where business_id = $1) as e,
            (select md5(coalesce(string_agg(t::text, ',' order by t::text), '')) from public.alerts t where business_id = $1) as al`,
    [on.business],
  );

describe.skipIf(url === undefined)('T3e1: drops are not cancellations', { timeout: 60_000 }, () => {
  let s: Schedules;
  let other: Schedules;

  const dropBack = async (w: Picked, report: Record<string, unknown>) =>
    await asAgent(s, { ...handbackBody(w.picked), outcome: 'dropped', report }, w.credential);

  /** The drop is recorded, attributed, told and reactivated, and the progress carries on. */
  async function expectDropped(w: Picked, cause: string, fault: string): Promise<void> {
    const [first, second] = await attempts(s, w.taskId);
    expect(first).toMatchObject({ state: 'dropped', drop_cause: cause, held: 'abandoned' });
    expect(second).toMatchObject({ state: 'reserved', drop_cause: null, held: 'held' });
    const trail = await events(s, w.taskId);
    expect(trail.map((one) => one.kind)).toStrictEqual(['claimed', 'dropped', 'reactivated']);
    expect(new Set(trail.map((one) => one.run_id)).size).toBe(1);
    expect(trail[1]?.detail).toMatchObject({ cause, fault });
    expect(trail[2]?.detail).toMatchObject({ after: 2, attemptId: second?.id });
    expect(await alerts(s, w.taskId)).toStrictEqual(['dropped']);

    // Resumed from its last event, not from zero: the next pickup is position 4.
    const again = await pickup(s, (await reservationOf(second?.id as string)) as string);
    expect(again['attemptId']).toBe(second?.id);
    const after = await events(s, w.taskId);
    expect(after.map((one) => [one.position, one.kind])).toStrictEqual([
      ['1', 'claimed'],
      ['2', 'dropped'],
      ['3', 'reactivated'],
      ['4', 'claimed'],
    ]);
  }

  const reservationOf = async (attemptId: string): Promise<string | undefined> =>
    (
      await rows<{ reservation_id: string }>(
        s,
        'select reservation_id from public.attempts where business_id = $1 and id = $2',
        [s.business, attemptId],
      )
    )[0]?.reservation_id;

  beforeAll(async () => {
    s = await openSchedules('t3e1', 1_000_000);
    other = await openSecond(s, 't3e1-away');
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it('drop_is_not_cancel: the provider did not answer, the provider fault, reactivated with a person told', async () => {
    const w = await work(s);
    appliedDetail(await dropBack(w, { dropCause: 'provider_unavailable' }), 'task.handback');
    await expectDropped(w, 'provider_unavailable', 'provider');
  });

  it('drop_is_not_cancel: the connection was lost, the network fault, reactivated with a person told', async () => {
    const w = await work(s);
    appliedDetail(await dropBack(w, { dropCause: 'connection_lost' }), 'task.handback');
    await expectDropped(w, 'connection_lost', 'network');
  });

  it('drop_is_not_cancel: our worker was lost, our fault; the run stays running until its lease runs out', async () => {
    const w = await work(s, 1);
    const before = await attempts(s, w.taskId);
    expect(before).toMatchObject([{ state: 'reserved', held: 'held' }]);
    await new Promise((resolve) => {
      setTimeout(resolve, 1_300);
    });
    await sweep(s);
    await expectDropped(w, 'worker_lost', 'ours');
  });

  it("drop_is_not_cancel: a person's cancellation at the same point is never a drop and never comes back", async () => {
    const w = await work(s);
    const [lineage] = await rows<{ lineage_id: string }>(
      s,
      `select run.lineage_id from public.reservations res
         join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
        where res.business_id = $1 and res.id = $2`,
      [s.business, w.decision['reservationId']],
    );
    const cancel = {
      command: 'task.cancel',
      operationId: randomUUID(),
      recordId: w.taskId,
      lineageId: lineage?.lineage_id,
      reason: 'a person stops this work',
    };
    appliedDetail(await asPerson(s, cancel), 'task.cancel');
    // Replayed by its operation identity: the same answer, nothing new.
    appliedDetail(await asPerson(s, cancel), 'task.cancel');
    await sweep(s);
    expect(await attempts(s, w.taskId)).toStrictEqual([
      expect.objectContaining({ state: 'abandoned', drop_cause: null, held: 'abandoned' }),
    ]);
    expect((await events(s, w.taskId)).map((one) => one.kind)).toStrictEqual(['claimed']);
    expect(await alerts(s, w.taskId)).toStrictEqual(['cancelled']);
    // The worker, woken, is refused: its work is gone and nothing reactivated it.
    const woken = await asAgent(s, { ...handbackBody(w.picked) }, w.credential);
    expect(codeOf(woken)).not.toBe('ok');
  });

  it('a worker names only a provider or connection cause; anything else is refused and writes nothing', async () => {
    const w = await work(s);
    for (const report of [{ dropCause: 'worker_lost' }, { dropCause: 'nonsense' }, {}]) {
      // eslint-disable-next-line no-await-in-loop
      expect(codeOf(await dropBack(w, report))).toBe('FIELD_VALUE_INVALID');
    }
    expect(await attempts(s, w.taskId)).toMatchObject([{ state: 'reserved', drop_cause: null }]);
    expect((await events(s, w.taskId)).map((one) => one.kind)).toStrictEqual(['claimed']);
    expect(await alerts(s, w.taskId)).toStrictEqual([]);
  });

  it('a dispatched step that drops keeps its whole hold unknown, with the cause, for the reconciliation pass', async () => {
    const w = await work(s);
    appliedDetail(
      await asAgent(
        s,
        {
          command: 'task.dispatch',
          operationId: randomUUID(),
          leaseId: w.picked['leaseId'],
          fence: w.picked['fence'],
        },
        w.credential,
      ),
      'task.dispatch',
    );
    appliedDetail(await dropBack(w, { dropCause: 'provider_unavailable' }), 'task.handback');
    expect(await attempts(s, w.taskId)).toStrictEqual([
      expect.objectContaining({
        state: 'liability_unknown',
        drop_cause: 'provider_unavailable',
        held: 'held',
      }),
    ]);
    // Only proof resumes it (T3d1): no reactivation here.
    expect((await events(s, w.taskId)).map((one) => one.kind)).toStrictEqual([
      'claimed',
      'dropped',
    ]);
  });

  it('business to business: a drop here never moves the other business, and its attribution names only this one', async () => {
    const away = await work(other);
    const before = await digest(other);
    const w = await work(s, 1);
    await new Promise((resolve) => {
      setTimeout(resolve, 1_300);
    });
    await sweep(s);
    appliedDetail(await dropBack(await work(s), { dropCause: 'connection_lost' }), 'task.handback');
    expect(await digest(other)).toStrictEqual(before);
    expect(await attempts(other, away.taskId)).toMatchObject([{ state: 'reserved' }]);
    expect((await attempts(s, w.taskId))[0]).toMatchObject({ drop_cause: 'worker_lost' });
  });
});
