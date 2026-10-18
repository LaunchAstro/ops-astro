// SPDX-License-Identifier: AGPL-3.0-only
//
// The scheduled sweep entry (`apps/automations/sweep.ts`) with firing on: one
// invocation is one round over the businesses its keys name. An adopted
// one-minute activation gets one occurrence and one run, started by its
// business's own active worker. A business with no worker yet is skipped and
// counted, and a key that names no business is counted as failed.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepEntry } from '../../apps/automations/sweep.ts';
import { installSpine } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { bravoApproved } from './firing.ts';
import { insertWorker } from './run-start.ts';
import { entrySettings, oneMinuteActivation } from './scheduled-entry.ts';
import { runsOf } from './sweep-race.ts';
import { createAutomationWorld, type AutomationWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();
const AT = (): Date => new Date(Date.UTC(2026, 10, 3, 9, 30));

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('the scheduled entry with firing on', () => {
  let w: AutomationWorld;
  let worker: string;
  let activationId: string;

  beforeAll(async () => {
    w = await createAutomationWorld('schedentry');
    await installSpine(w.db.app, w.alpha);
    await installSpine(w.db.app, w.bravo);
    // Alpha has its worker; bravo has none yet.
    worker = await insertWorker(w.db, w.alpha);
    activationId = await oneMinuteActivation(w);
  });

  afterAll(async () => {
    await w?.db.drop();
  });

  it('fires an adopted one-minute activation once as its business worker, and counts a business with no worker', async () => {
    await bravoApproved(w, 'scheduled', 'Bravo hourly report');
    expect(await sweepEntry(entrySettings(w, 'alpha,bravo'), { now: AT })).toEqual({
      code: 0,
      line: '{"firing":"on","swept":1,"noWorker":1,"failed":0}',
    });
    expect(await w.occurrences(activationId)).toBe(1);
    expect(await runsOf(w, activationId)).toBe(1);
    // The run was started as alpha's own worker, and bravo was not swept.
    expect(
      await w.count(
        `select count(*) as n from public.audit_events
          where command = 'occurrence.run_start' and business_id = $1 and actor_id = $2`,
        [w.alpha, worker],
      ),
    ).toBe(1);
    expect(
      await w.count(
        'select count(*) as n from public.activation_occurrences where business_id = $1',
        [w.bravo],
      ),
    ).toBe(0);
  });

  it('counts a key that names no business as failed and exits 1', async () => {
    expect(await sweepEntry(entrySettings(w, 'alpha,nobody'), { now: AT })).toEqual({
      code: 1,
      line: '{"firing":"on","swept":1,"noWorker":0,"failed":1}',
    });
    // The minute already fired: alpha's pass starts nothing again.
    expect(await w.occurrences(activationId)).toBe(1);
    expect(await runsOf(w, activationId)).toBe(1);
  });
});
