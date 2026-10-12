// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { appliedDetail, codeOf, openSchedules, type Schedules } from './schedules-harness.ts';
import { openBilling, t3d1Harness } from './t3d1-harness.ts';
import { holdOf, writeOffBody } from './t3c-harness.ts';
import { asPerson } from './schedules-harness.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a work outcome after a write-off',
  () => {
    let s: Schedules;
    const h = t3d1Harness(() => s);
    beforeAll(async () => {
      s = await openSchedules('outcomeafterwriteoff', 1_000_000);
      await openBilling(s);
    }, 180_000);
    afterAll(async () => {
      await s?.db.drop();
    });

    it('a later work outcome remains recordable after a write-off', async () => {
      const w = await h.unknownStep({ applied: false });
      appliedDetail(await asPerson(s, writeOffBody(w, 1_000)), 'budget.write_off');
      const written = await holdOf(s, w);
      expect(written).toMatchObject({
        attempt_state: 'settled',
        outcome: 'unknown',
        reservation_actual: '1000',
        envelope_actual: '1000',
        classified_cause: 'written_off',
      });
      const recorded = await h.outcome(w, 'nothing_happened');
      expect(codeOf(recorded)).toBe('applied');
      expect(await holdOf(s, w)).toMatchObject({
        reservation_actual: '1000',
        envelope_actual: '1000',
        classified_cause: 'written_off',
      });
    });
  },
);
