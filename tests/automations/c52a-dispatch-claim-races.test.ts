// SPDX-License-Identifier: AGPL-3.0-only
//
// C52-A run start under concurrent writers (Sol PRV-oa-1048-R1, both races).
// R1.1: a worker that claims and dispatches in one transaction never
// deadlocks with another claimer of the same activation, and a transaction
// never takes a second activation after the first's business-wide locks.
// R1.2: a worker stopped while its admitted dispatch is still open either
// waits for the run start to commit or, stopped first or in flight, gets no
// run. Each race runs on separate connections, and the wait is proved by
// pg_blocking_pids, not by timing.

import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { occurrenceRunStarter } from '../../packages/core-commands/src/index.ts';
import {
  claimOccurrence,
  connect,
  dispatchOccurrence,
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';
import { barrier } from '../runtime/gate-negatives-cases.ts';
import { databaseUrlFromEnvironment, type FreshDatabase } from '../support/fresh-database.ts';
import { firingOf, occurrenceOf, type Firing } from './firing.ts';
import { finishRuns, hourPasses, insertWorker, prepareRuns } from './run-start.ts';
import { createAutomationWorld, type AutomationWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

/** Waits until some backend of this database is blocked by another (pg_blocking_pids). */
async function awaitBlocked(db: FreshDatabase): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // Polling is sequential by definition.
    // eslint-disable-next-line no-await-in-loop
    const rows = await db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from pg_stat_activity
        where datname = current_database() and cardinality(pg_blocking_pids(pid)) > 0`,
    );
    if (Number(rows[0]?.n ?? 0) > 0) return;
    // eslint-disable-next-line no-await-in-loop
    await delay(25);
  }
  throw new Error('no backend was ever blocked by another: the race was not established');
}

/** Stops a worker: the actor row's authority ends with this write. */
async function stopWorker(tx: TenantQuery, business: string, worker: string): Promise<void> {
  await tx.query(
    `update public.actors set active = false, deactivated_at = clock_timestamp()
      where business_id = $1 and id = $2`,
    [business, worker],
  );
}

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C52-A dispatch and claim races', () => {
  let w: AutomationWorld;
  let f: Firing;

  beforeAll(async () => {
    w = await createAutomationWorld('c52c');
    f = firingOf(w);
    await prepareRuns(w);
  });

  // Each case starts under the business's run ceiling and the hourly rates.
  beforeEach(async () => {
    await finishRuns(w, w.alpha);
    await hourPasses(w);
  });

  afterAll(async () => {
    await w?.db.drop();
  });

  it('a claim and its dispatch in one transaction, with another claimer of the same activation parked behind it on a separate connection: both commit, no deadlock', async () => {
    const { activation } = await f.approved();
    const worker = await insertWorker(w.db, w.alpha);
    const held = barrier();
    const firstIn = barrier();
    const other = connect(w.db.appUrl, { source: 'runtime' });
    try {
      // The worker claims, then holds its transaction open before it dispatches.
      const first = w.inAlpha(async (tx) => {
        try {
          const claim = await claimOccurrence(tx, activation.id, { dueAt: f.nextDue() });
          firstIn.release();
          await held.held;
          const started = occurrenceRunStarter(worker);
          return (await dispatchOccurrence(tx, occurrenceOf(claim).id, started)).kind;
        } finally {
          firstIn.release();
        }
      });
      await firstIn.held;
      const second = other.withBusiness(
        w.alpha,
        async (tx) =>
          occurrenceOf(await claimOccurrence(tx, activation.id, { dueAt: f.nextDue() })).outcome,
      );
      await awaitBlocked(w.db);
      held.release();
      expect(await Promise.allSettled([first, second])).toEqual([
        { status: 'fulfilled', value: 'dispatched' },
        { status: 'fulfilled', value: 'approved' },
      ]);
    } finally {
      held.release();
      await other.close();
    }
  }, 60_000);

  it('a worker stopped while its admitted dispatch is open waits for the run start to commit, and a worker stopped first starts no run', async () => {
    const { activation } = await f.approved();
    const worker = await insertWorker(w.db, w.alpha);
    // The stop has its own connection: the admin pool holds one, and the
    // pg_blocking_pids poll must not queue behind a stop that is waiting.
    const other = connect(w.db.appUrl, { source: 'runtime' });
    const due = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    const held = barrier();
    const startedIn = barrier();
    const order: string[] = [];
    try {
      const first = w.inAlpha(async (tx) => {
        try {
          const dispatch = await dispatchOccurrence(tx, due.id, occurrenceRunStarter(worker));
          startedIn.release();
          await held.held;
          return dispatch.kind;
        } finally {
          startedIn.release();
        }
      });
      await startedIn.held;
      const stopped = other
        .withBusiness(w.alpha, async (tx) => await stopWorker(tx, w.alpha, worker))
        .then(() => order.push('stopped'));
      try {
        await awaitBlocked(w.db);
      } finally {
        order.push('released');
        held.release();
      }
      expect(await first).toBe('dispatched');
      await stopped;
      expect(order).toEqual(['released', 'stopped']);
    } finally {
      held.release();
      await other.close();
    }

    // Stopped first: the next approved occurrence of that worker starts nothing.
    const next = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    const refused = await w.inAlpha(
      async (tx) => await dispatchOccurrence(tx, next.id, occurrenceRunStarter(worker)),
    );
    expect(refused).toEqual({ kind: 'refused', code: 'WORKER_REQUIRED' });
  }, 60_000);

  it('a transaction that claimed for one activation is refused a claim or a dispatch for another, so no writer takes a second activation row after its business-wide locks', async () => {
    const x = await f.approved();
    const y = await f.approved();
    const yDue = occurrenceOf(await w.claim(y.activation.id, { dueAt: f.nextDue() }));
    const worker = await insertWorker(w.db, w.alpha);
    const afterClaimingX = async (then: (tx: TenantQuery) => Promise<unknown>): Promise<unknown> =>
      await w.inAlpha(async (tx) => {
        await claimOccurrence(tx, x.activation.id, { dueAt: f.nextDue() });
        return await then(tx);
      });
    await expect(
      afterClaimingX(
        async (tx) => await claimOccurrence(tx, y.activation.id, { dueAt: f.nextDue() }),
      ),
    ).rejects.toThrow('one transaction locks one activation');
    await expect(
      afterClaimingX(
        async (tx) => await dispatchOccurrence(tx, yDue.id, occurrenceRunStarter(worker)),
      ),
    ).rejects.toThrow('one transaction locks one activation');
  }, 60_000);

  it('a run start that arrives while its worker is being stopped waits for the stop and is refused, writing no run and no dispatch', async () => {
    const { activation } = await f.approved();
    const worker = await insertWorker(w.db, w.alpha);
    const due = occurrenceOf(await w.claim(activation.id, { dueAt: f.nextDue() }));
    const held = barrier();
    const stopIn = barrier();
    const other = connect(w.db.appUrl, { source: 'runtime' });
    try {
      // The stop is written and held open, uncommitted, before the start arrives.
      const stopping = other.withBusiness(w.alpha, async (tx) => {
        try {
          await stopWorker(tx, w.alpha, worker);
          stopIn.release();
          await held.held;
        } finally {
          stopIn.release();
        }
      });
      await stopIn.held;
      const start = w.inAlpha(
        async (tx) => await dispatchOccurrence(tx, due.id, occurrenceRunStarter(worker)),
      );
      await awaitBlocked(w.db);
      held.release();
      await stopping;
      expect(await start).toEqual({ kind: 'refused', code: 'WORKER_REQUIRED' });
      const runs = await w.count(
        'select count(*) as n from public.planned_runs where origin_occurrence_id = $1',
        [due.id],
      );
      const dispatches = await w.count(
        'select count(*) as n from public.occurrence_dispatches where occurrence_id = $1',
        [due.id],
      );
      expect([runs, dispatches]).toEqual([0, 0]);
    } finally {
      held.release();
      await other.close();
    }
  }, 60_000);
});
