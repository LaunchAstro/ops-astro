// SPDX-License-Identifier: AGPL-3.0-only
//
// The API's occurrence sweeper (`startOccurrenceSweeper`) when more than one
// runs, or one stops mid-pass. Two API processes, each with its own pool,
// sweeping the same business at the same due time start its run once. A
// `stop` sent while a pass waits on an activation's lock resolves only once
// that pass has committed, and starts no further business. A pass still
// running when the next is due holds the next back rather than stacking it.

import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startOccurrenceSweeper } from '../../apps/api/occurrence-sweeper.ts';
import { connect, type BusinessId, type Database } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { bravoApproved, firingOf, waitingOn } from './firing.ts';
import { prepareRuns } from './run-start.ts';
import { holdActivation, runsOf } from './sweep-race.ts';
import { createAutomationWorld, type AutomationWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();
const AT = (): Date => new Date(Date.UTC(2026, 10, 5, 9, 30));

/* eslint-disable max-lines-per-function -- one world per case, the cases that share its helpers */
describe.skipIf(serverUrl === undefined)(
  'API occurrence sweepers at once, or stopped mid-pass',
  () => {
    let w: AutomationWorld;
    const pools: Database[] = [];

    beforeEach(async () => {
      w = await createAutomationWorld('sweeperrace');
      await prepareRuns(w);
    });

    afterEach(async () => {
      await Promise.all(pools.splice(0).map(async (pool) => await pool.close()));
      await w?.db.drop();
    });

    /** An API process's own pool. */
    const own = (): Database => {
      const pool = connect(w.db.appUrl);
      pools.push(pool);
      return pool;
    };

    it('two API processes sweeping one business at once start its due run once', async () => {
      const { activation } = await firingOf(w).approved();
      const held = await holdActivation(w, activation.id);
      const sweepers = [own(), own()].map((pool) =>
        startOccurrenceSweeper(pool, {
          businesses: async () => await Promise.resolve([w.alpha as BusinessId]),
          everyMs: 3_600_000,
          now: AT,
        }),
      );
      try {
        await waitingOn(w, 2);
      } finally {
        await held.letGo();
      }
      await Promise.all(sweepers.map(async (sweeper) => await sweeper.stop()));
      expect(await w.occurrences(activation.id)).toBe(1);
      expect(await runsOf(w, activation.id)).toBe(1);
    });

    it('a stop sent while a pass waits resolves once that pass commits, and starts no further business', async () => {
      const { activation } = await firingOf(w).approved();
      const bravo = await bravoApproved(w, 'scheduled', 'Bravo hourly report');
      const held = await holdActivation(w, activation.id);
      const sweeper = startOccurrenceSweeper(own(), {
        businesses: async () => await Promise.resolve([w.alpha, w.bravo] as BusinessId[]),
        everyMs: 3_600_000,
        now: AT,
      });
      let stopped = false;
      let stopping: Promise<void> | undefined;
      try {
        await waitingOn(w, 1);
        stopping = (async () => {
          await sweeper.stop();
          stopped = true;
        })();
        // The pass is held on the lock: nothing it waits for has happened, so stop has not either.
        await delay(200);
        expect(stopped).toBe(false);
      } finally {
        await held.letGo();
      }
      await stopping;
      expect(await runsOf(w, activation.id)).toBe(1);
      expect(await w.occurrences(bravo.activationId)).toBe(0);
    });

    it('a pass still running when the next is due holds the next back, not stacked beside it', async () => {
      const { activation } = await firingOf(w).approved();
      const held = await holdActivation(w, activation.id);
      let started = 0;
      const sweeper = startOccurrenceSweeper(own(), {
        businesses: async () => {
          started += 1;
          return await Promise.resolve([w.alpha as BusinessId]);
        },
        everyMs: 20,
        now: AT,
      });
      try {
        await waitingOn(w, 1);
        // Ten intervals pass while the first pass waits on the lock.
        await delay(200);
        expect(started).toBe(1);
      } finally {
        await held.letGo();
      }
      await expect.poll(() => started, { timeout: 5_000 }).toBeGreaterThan(1);
      await sweeper.stop();
      expect(await w.occurrences(activation.id)).toBe(1);
      expect(await runsOf(w, activation.id)).toBe(1);
    });
  },
);
