// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepOccurrences } from '../../packages/core-commands/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createAutomationWorld, type AutomationWorld } from '../automations/world.ts';
import { firingOf } from '../automations/firing.ts';
import { prepareRuns, type Workers } from '../automations/run-start.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'occurrence sweep rollback report',
  () => {
    let world: AutomationWorld;
    let workers: Workers;
    beforeAll(async () => {
      world = await createAutomationWorld('sol1400rollback');
      workers = await prepareRuns(world);
    });
    afterAll(async () => await world?.db.drop());

    it('rolled-back occurrences and runs are absent from the sweep report', async () => {
      const { activation } = await firingOf(world).approved();
      let transactions = 0;
      const database: Database = {
        log: world.db.app.log,
        close: () => world.db.app.close(),
        withBusiness: (business, work) =>
          world.db.app.withBusiness(business, async (tx) => {
            transactions += 1;
            const result = await work(tx);
            // The list was transaction one; abort transaction two after its writes, before commit.
            if (transactions === 2) throw new Error('abort the scheduled activation transaction');
            return result;
          }),
      };
      const report = await sweepOccurrences(database, {
        businessId: world.alpha,
        workerActorId: workers.worker,
        now: new Date('2026-11-02T09:00:00Z'),
      });
      expect(report.failed).toEqual([activation.id]);
      expect(await world.count('select count(*) as n from public.activation_occurrences')).toBe(0);
      expect(await world.count('select count(*) as n from public.planned_runs')).toBe(0);
      expect(report).toMatchObject({ claimed: [], started: [] });
    });
  },
);
