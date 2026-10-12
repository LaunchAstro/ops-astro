// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { openSchedules, type Schedules } from './schedules-harness.ts';

const noDatabase = process.env['DATABASE_URL'] === undefined;
const it = noDatabase ? vitestIt.skip : vitestIt;

let s: Schedules;
beforeAll(async () => {
  if (noDatabase) return;
  s = await openSchedules('origindefer', 1_000_000);
}, 180_000);
afterAll(async () => {
  await s?.db.drop();
});

it('the origin constraint can be deferred until transaction commit', async () => {
  await expect(
    s.db.app.withBusiness(s.business, async (tx) => {
      await tx.query('set constraints public.planned_runs_origin_is_approved deferred');
    }),
  ).resolves.toBeUndefined();
});
