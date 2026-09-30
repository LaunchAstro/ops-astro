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
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  codeOf,
  handbackBody,
  openSchedules,
  pickup,
  rows,
  type Schedules,
} from './schedules-harness.ts';
import { openSecond } from './t3b-harness.ts';
import {
  alerts,
  attempts,
  digest,
  events,
  sweep,
  toldIn,
  work,
  type Picked,
} from './t3e1-drops-reads.ts';

const url = databaseUrlFromEnvironment();

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
    // A person is told by the outage report the drop joins, not a per-run alert (T3e2).
    expect(await alerts(s, w.taskId)).toStrictEqual([]);
    expect(await toldIn(s, w.taskId)).toStrictEqual([cause]);

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
    expect(before).toMatchObject([{ state: 'dispatched', held: 'held' }]);
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
    expect(await attempts(s, w.taskId)).toMatchObject([
      { state: 'abandoned', drop_cause: null, held: 'abandoned' },
    ]);
    expect((await events(s, w.taskId)).map((one) => one.kind)).toStrictEqual(['claimed']);
    expect(await alerts(s, w.taskId)).toStrictEqual(['cancelled']);
    // The worker, woken, is refused: its work is gone and nothing reactivated it.
    const woken = await asAgent(s, { ...handbackBody(w.picked) }, w.credential);
    expect(codeOf(woken)).not.toBe('ok');
  });

  it('a worker names only a provider or connection cause; anything else is refused and writes nothing', async () => {
    const w = await work(s);
    for (const report of [
      { dropCause: 'worker_lost' },
      { dropCause: 'nonsense' },
      {},
      { dropCause: 'PROVIDER_UNAVAILABLE' },
      { dropCause: ' provider_unavailable' },
      { dropCause: ['provider_unavailable'] },
      { dropCause: 7 },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      expect(codeOf(await dropBack(w, report))).toBe('FIELD_VALUE_INVALID');
    }
    expect(await attempts(s, w.taskId)).toMatchObject([{ state: 'dispatched', drop_cause: null }]);
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
    expect(await attempts(s, w.taskId)).toMatchObject([
      { state: 'liability_unknown', drop_cause: 'provider_unavailable', held: 'held' },
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
    expect(await attempts(other, away.taskId)).toMatchObject([{ state: 'dispatched' }]);
    expect((await attempts(s, w.taskId))[0]).toMatchObject({ drop_cause: 'worker_lost' });
  });
  it("another holder's dropped hand-back on this lease is refused and writes nothing", async () => {
    const w = await work(s);
    const intruder = await work(s);
    const refused = await asAgent(
      s,
      { ...handbackBody(w.picked), outcome: 'dropped', report: { dropCause: 'connection_lost' } },
      intruder.credential,
    );
    expect(codeOf(refused)).not.toBe('ok');
    expect(await attempts(s, w.taskId)).toMatchObject([{ state: 'dispatched', drop_cause: null }]);
    expect((await events(s, w.taskId)).map((one) => one.kind)).toStrictEqual(['claimed']);
    expect(await alerts(s, w.taskId)).toStrictEqual([]);
  });

  it('two sweeps at once over one lost worker record one drop and bring the work back once', async () => {
    const w = await work(s, 1);
    await new Promise((resolve) => {
      setTimeout(resolve, 1_300);
    });
    const both = await Promise.allSettled([sweep(s), sweep(s)]);
    expect(both.some((one) => one.status === 'fulfilled')).toBe(true);
    await sweep(s);
    expect(await attempts(s, w.taskId)).toMatchObject([
      { state: 'dropped', drop_cause: 'worker_lost' },
      { state: 'reserved' },
    ]);
    expect((await events(s, w.taskId)).map((one) => one.kind)).toStrictEqual([
      'claimed',
      'dropped',
      'reactivated',
    ]);
    // A person is told by the outage report the drop joins, not a per-run alert (T3e2).
    expect(await alerts(s, w.taskId)).toStrictEqual([]);
    expect(await toldIn(s, w.taskId)).toStrictEqual(['worker_lost']);
  });
});
