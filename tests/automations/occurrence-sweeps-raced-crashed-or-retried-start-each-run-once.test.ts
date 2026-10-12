// SPDX-License-Identifier: AGPL-3.0-only
//
// The occurrence sweep's read-then-writes, attacked: the activation list read
// before each claim, the claim and its dispatch in one transaction, and the
// waiting list read before each waiting occurrence's dispatch. Two passes on
// two connections at once start each run once; a pass that dies between the
// read and the write, or between the write and its commit, leaves nothing
// behind, and the next pass starts the run once; a pass sent again after its
// report was lost starts nothing more. A turn-off committed while a pass waits
// on the activation's lock is the one the pass sees.

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  sweepOccurrences,
  type OccurrenceSweepReport,
} from '../../packages/core-commands/src/index.ts';
import {
  connect,
  turnOffActivation,
  type Database,
} from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { firingOf, waitingOn, type Firing } from './firing.ts';
import { prepareRuns, type Workers } from './run-start.ts';
import { crashingAt, firedOf, holdActivation, runsOf } from './sweep-race.ts';
import { createAutomationWorld, type AutomationWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

/** Half past nine: an hourly activation is due at nine. */
const AT = new Date(Date.UTC(2026, 10, 4, 9, 30));
const NINE = new Date(Date.UTC(2026, 10, 4, 9, 0)).toISOString();

const total = (reports: readonly OccurrenceSweepReport[], key: keyof OccurrenceSweepReport) =>
  reports.flatMap((report) => report[key]);

// eslint-disable-next-line max-lines-per-function -- one world per case, the cases that share its helpers
describe.skipIf(serverUrl === undefined)('occurrence sweeps raced, crashed or retried', () => {
  let w: AutomationWorld;
  let f: Firing;
  let k: Workers;
  const pools: Database[] = [];

  beforeEach(async () => {
    w = await createAutomationWorld('sweeprace');
    f = firingOf(w);
    k = await prepareRuns(w);
  });

  afterEach(async () => {
    await Promise.all(pools.splice(0).map(async (pool) => await pool.close()));
    await w?.db.drop();
  });

  /** A pool of its own: the world's pool holds one connection, so two passes on it queue. */
  const own = (): Database => {
    const pool = connect(w.db.appUrl);
    pools.push(pool);
    return pool;
  };

  const sweep = async (database: Database = w.db.app, at: Date = AT) =>
    await sweepOccurrences(database, { businessId: w.alpha, workerActorId: k.worker, now: at });

  /** Each pass started on its own connection while the activation is held, let go once all wait. */
  const sweptTogether = async (activationId: string, passes: number) => {
    const held = await holdActivation(w, activationId);
    const sent = Array.from({ length: passes }, async () => await sweep(own()));
    try {
      await waitingOn(w, passes);
    } finally {
      await held.letGo();
    }
    return await Promise.all(sent);
  };

  /** An approved event activation's queued occurrence, which only the waiting list dispatches. */
  const queuedEvent = async () => {
    const approved = await f.approved('event');
    const claim = await w.claim(approved.activation.id, { eventId: randomUUID() });
    if (claim.kind !== 'claimed') throw new Error(`the event claim answered ${claim.kind}`);
    return { activationId: approved.activation.id, occurrenceId: claim.occurrence.id };
  };

  it('two passes at once claim a due activation once and start its run once', async () => {
    const { activation } = await f.approved();
    const reports = await sweptTogether(activation.id, 2);
    expect(total(reports, 'failed')).toEqual([]);
    expect(await firedOf(w, activation.id)).toEqual([
      { due: NINE, outcome: 'approved', started: true },
    ]);
    expect(await runsOf(w, activation.id)).toBe(1);
    expect(total(reports, 'claimed')).toHaveLength(1);
    expect(total(reports, 'started')).toHaveLength(1);
  });

  it('two passes at once dispatch a queued occurrence once', async () => {
    const queued = await queuedEvent();
    const reports = await sweptTogether(queued.activationId, 2);
    expect(total(reports, 'failed')).toEqual([]);
    expect(await runsOf(w, queued.activationId)).toBe(1);
    expect(total(reports, 'started')).toHaveLength(1);
  });

  it('a turn-off committed while a pass waits on the lock starts no run', async () => {
    const { activation } = await f.approved();
    const held = await holdActivation(w, activation.id, async (tx, row) => {
      const off = await turnOffActivation(tx, {
        activationId: row.id,
        expectedRevision: row.revision,
        actorId: w.admin.actorId,
      });
      expect(off.kind).toBe('off');
    });
    const sent = sweep(own());
    try {
      await waitingOn(w, 1);
    } finally {
      await held.letGo();
    }
    expect((await sent).started).toEqual([]);
    expect(await runsOf(w, activation.id)).toBe(0);
    expect((await firedOf(w, activation.id)).map((one) => one.outcome)).toEqual(['activation_off']);
  });

  it('a pass that dies after its activation list, before its claim, writes nothing and the next pass starts the run once', async () => {
    const { activation } = await f.approved();
    // The list is transaction one; the claim and dispatch, transaction two.
    const crashed = await sweep(crashingAt(own(), 2, 'before-work'));
    expect(crashed.failed).toEqual([activation.id]);
    expect(await firedOf(w, activation.id)).toEqual([]);
    await sweep();
    expect(await firedOf(w, activation.id)).toEqual([
      { due: NINE, outcome: 'approved', started: true },
    ]);
    expect(await runsOf(w, activation.id)).toBe(1);
  });

  it('a pass whose claim is cancelled while it waits on the lock writes nothing and the next pass starts the run once', async () => {
    const { activation } = await f.approved();
    const held = await holdActivation(w, activation.id);
    const sent = sweep(own());
    try {
      await waitingOn(w, 1);
      await w.db.admin.execute(
        `select pg_cancel_backend(pid) from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
      );
      expect((await sent).failed).toEqual([activation.id]);
    } finally {
      await held.letGo();
    }
    expect(await firedOf(w, activation.id)).toEqual([]);
    await sweep();
    expect(await runsOf(w, activation.id)).toBe(1);
  });

  it('a pass that aborts after its claim and dispatch, before the commit, leaves no occurrence or run and the next pass starts the run once', async () => {
    const { activation } = await f.approved();
    const crashed = await sweep(crashingAt(own(), 2, 'before-commit'));
    expect(crashed).toEqual({ claimed: [], started: [], failed: [activation.id] });
    expect(await firedOf(w, activation.id)).toEqual([]);
    expect(await runsOf(w, activation.id)).toBe(0);
    const next = await sweep();
    expect(next.started).toHaveLength(1);
    expect(await firedOf(w, activation.id)).toEqual([
      { due: NINE, outcome: 'approved', started: true },
    ]);
  });

  it('a pass that dies after its waiting list, before the dispatch, leaves the occurrence waiting and the next pass starts it once', async () => {
    const queued = await queuedEvent();
    // No scheduled activation: the activation list, the waiting list, then the dispatch.
    const crashed = await sweep(crashingAt(own(), 3, 'before-work'));
    expect(crashed.failed).toEqual([queued.occurrenceId]);
    expect(await runsOf(w, queued.activationId)).toBe(0);
    expect((await sweep()).started).toHaveLength(1);
    expect(await runsOf(w, queued.activationId)).toBe(1);
  });

  it('a pass that aborts after a waiting dispatch, before the commit, leaves no run and the next pass starts it once', async () => {
    const queued = await queuedEvent();
    const crashed = await sweep(crashingAt(own(), 3, 'before-commit'));
    expect(crashed).toEqual({ claimed: [], started: [], failed: [queued.occurrenceId] });
    expect(await runsOf(w, queued.activationId)).toBe(0);
    expect((await sweep()).started).toHaveLength(1);
    expect(await runsOf(w, queued.activationId)).toBe(1);
  });

  it('a pass sent again after its report was lost claims and starts nothing more', async () => {
    const { activation } = await f.approved();
    const queued = await queuedEvent();
    const first = await sweep();
    expect(first.started).toHaveLength(2);
    expect(await sweep()).toEqual({ claimed: [], started: [], failed: [] });
    expect(await firedOf(w, activation.id)).toEqual([
      { due: NINE, outcome: 'approved', started: true },
    ]);
    expect(await runsOf(w, activation.id)).toBe(1);
    expect(await runsOf(w, queued.activationId)).toBe(1);
  });
});
