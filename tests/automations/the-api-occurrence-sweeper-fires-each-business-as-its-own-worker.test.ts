// SPDX-License-Identifier: AGPL-3.0-only
//
// The API's occurrence sweeper (`startOccurrenceSweeper`, apps/api), the one
// shipped caller of the occurrence sweep: its first round, at start, fires
// each business's due scheduled activation as that business's own active
// worker, skips a business that has no worker yet, and once stopped starts
// no further round.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startOccurrenceSweeper } from '../../apps/api/occurrence-sweeper.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { bravoApproved, firingOf } from './firing.ts';
import { finishRuns, insertWorker } from './run-start.ts';
import { installSpine } from '../commands/fixture.ts';
import { createAutomationWorld, type AutomationWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('the API occurrence sweeper', () => {
  let w: AutomationWorld;
  let worker: string;

  beforeAll(async () => {
    w = await createAutomationWorld('osweeper');
    await installSpine(w.db.app, w.alpha);
    await installSpine(w.db.app, w.bravo);
    // Alpha has its worker; bravo has none yet.
    worker = await insertWorker(w.db, w.alpha);
  });

  afterAll(async () => {
    await w?.db.drop();
  });

  it('fires a due activation as its business worker at start, skips a business with no worker, and stops', async () => {
    await finishRuns(w, w.alpha);
    const { activation } = await firingOf(w).approved();
    const bravo = await bravoApproved(w, 'scheduled', 'Bravo hourly report');
    const sweeper = startOccurrenceSweeper(w.db.app, {
      businesses: async () => await Promise.resolve([w.alpha, w.bravo]),
      everyMs: 3_600_000,
      now: () => new Date(Date.UTC(2026, 10, 3, 9, 30)),
    });
    await expect
      .poll(async () => await w.count('select count(*) as n from public.planned_runs'), {
        timeout: 10_000,
      })
      .toBe(1);
    await sweeper.stop();
    expect(await w.occurrences(activation.id)).toBe(1);
    expect(
      await w.count(
        'select count(*) as n from public.activation_occurrences where activation_id = $1',
        [bravo.activationId],
      ),
    ).toBe(0);
    // The run was started as alpha's own worker.
    expect(
      await w.count(
        `select count(*) as n from public.audit_events
          where command = 'occurrence.run_start' and business_id = $1 and actor_id = $2`,
        [w.alpha, worker],
      ),
    ).toBe(1);
  });
});
