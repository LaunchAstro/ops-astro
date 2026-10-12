// SPDX-License-Identifier: AGPL-3.0-only
//
// The occurrence sweep reads each activation's `every_minutes` in its list
// transaction, before the claim takes the activation's lock. A schedule change
// (`activation.change`, then its adoption) committed while the claim waits on
// that lock is the schedule the claim must judge the due time by: an hourly
// activation made daily is due at midnight, never at the hour the stale list
// named, and the pass after it starts nothing more that day.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepOccurrences } from '../../packages/core-commands/src/index.ts';
import { adoptVersion, changeActivation, connect } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { firingOf, waitingOn } from './firing.ts';
import { prepareRuns, type Workers } from './run-start.ts';
import { firedOf, holdActivation } from './sweep-race.ts';
import { createAutomationWorld, type AutomationWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('a schedule changed while a sweep waits', () => {
  let w: AutomationWorld;
  let k: Workers;

  beforeAll(async () => {
    w = await createAutomationWorld('sweepschedule');
    k = await prepareRuns(w);
  });

  afterAll(async () => {
    await w?.db.drop();
  });

  it('an hourly activation made daily while the claim waits on its lock runs once, at its daily due time', async () => {
    const { activation, version } = await firingOf(w).approved();
    const held = await holdActivation(w, activation.id, async (tx, row) => {
      const changed = await changeActivation(tx, row.id, row.revision, {
        versionId: version.id,
        mode: 'scheduled',
        everyMinutes: 1440,
        eventKind: null,
        enabled: true,
        actorId: w.admin.actorId,
      });
      if (changed === null) throw new Error('the schedule was not changed');
      const adopted = await adoptVersion(tx, {
        activationId: row.id,
        versionId: version.id,
        expectedRevision: changed.revision,
        act: 'adopted',
        actorId: w.admin.actorId,
      });
      expect(adopted.kind).toBe('adopted');
    });
    const pool = connect(w.db.appUrl);
    const sweep = async (minute: number) =>
      await sweepOccurrences(pool, {
        businessId: w.alpha,
        workerActorId: k.worker,
        now: new Date(Date.UTC(2026, 10, 4, 9, minute)),
      });
    try {
      const sent = sweep(30);
      try {
        await waitingOn(w, 1);
      } finally {
        await held.letGo();
      }
      await sent;
      // The next pass, a minute later, under the daily schedule.
      await sweep(31);
    } finally {
      await pool.close();
    }
    expect(await firedOf(w, activation.id)).toEqual([
      {
        due: new Date(Date.UTC(2026, 10, 4, 0, 0)).toISOString(),
        outcome: 'approved',
        started: true,
      },
    ]);
  });
});
