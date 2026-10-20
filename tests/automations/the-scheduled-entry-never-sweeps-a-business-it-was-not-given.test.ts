// SPDX-License-Identifier: AGPL-3.0-only
//
// The scheduled sweep entry (`apps/automations/sweep.ts`) sweeps only the
// businesses its own `AUTOMATION_BUSINESS_KEYS` names. A second business with
// an active worker and a due adopted activation, left out of the keys, gets no
// occurrence and no run; given its key, the same activation fires, so it was
// ready to.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepEntry } from '../../apps/automations/sweep.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { bravoApproved } from './firing.ts';
import { prepareRuns } from './run-start.ts';
import { entrySettings, oneMinuteActivation } from './scheduled-entry.ts';
import { createAutomationWorld, type AutomationWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();
const AT = (): Date => new Date(Date.UTC(2026, 10, 7, 9, 30));

describe.skipIf(serverUrl === undefined)(
  'the scheduled entry and the businesses it is given',
  () => {
    let w: AutomationWorld;

    beforeAll(async () => {
      w = await createAutomationWorld('schedentryscope');
      await prepareRuns(w);
    });

    afterAll(async () => {
      await w?.db.drop();
    });

    const inBravo = async (table: string): Promise<number> =>
      await w.count(`select count(*) as n from public.${table} where business_id = $1`, [w.bravo]);

    it('a business left out of the keys gets no occurrence and no run, though it is due', async () => {
      const alphaActivation = await oneMinuteActivation(w);
      const bravo = await bravoApproved(w, 'scheduled', 'Bravo hourly report');
      expect(await sweepEntry(entrySettings(w, 'alpha'), { now: AT })).toEqual({
        code: 0,
        line: '{"firing":"on","swept":1,"noWorker":0,"failed":0}',
      });
      expect(await w.occurrences(alphaActivation)).toBe(1);
      expect(await inBravo('activation_occurrences')).toBe(0);
      expect(await inBravo('planned_runs')).toBe(0);

      // Control: given bravo's key, its activation fires, so it was due all along.
      expect(await sweepEntry(entrySettings(w, 'bravo'), { now: AT })).toEqual({
        code: 0,
        line: '{"firing":"on","swept":1,"noWorker":0,"failed":0}',
      });
      expect(
        await w.count(
          'select count(*) as n from public.activation_occurrences where activation_id = $1',
          [bravo.activationId],
        ),
      ).toBe(1);
    });
  },
);
