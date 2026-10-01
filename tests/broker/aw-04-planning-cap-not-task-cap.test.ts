// SPDX-License-Identifier: AGPL-3.0-only
//
// `AW-04 planning cap is not the task cap` (SL11-26 interim review): the first
// planning reply writes the default planning cap row (AUD 50). A business with
// no task cap of its own must still have none afterwards: task approvals,
// proposals and restarts draw on `readBusinessCapId`, which falls back to the
// oldest cap under any key, so without a key filter they start drawing on the
// planning allowance, and the two budgets count their spend apart.

import { expect, it as vitestIt } from 'vitest';
import { readBusinessCapId } from '../../packages/core-runtime/src/index.ts';
import { seedSchedules } from '../runtime/schedules-harness.ts';
import { noDatabase, s, world } from './broker-world.ts';
import { ask, ownerOf, plan, usePlanningWorld } from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

usePlanningWorld('aw04nottask');

it('AW-04 planning cap is not the task cap: after the first planning reply writes the default row, a business with no task cap still has none', async () => {
  const fresh = await seedSchedules(s.db, 'aw04nottask-fresh', 1_000_000);
  // A business nobody gave a task cap: the seeded `local` row removed.
  await s.db.admin.execute(`delete from public.budget_caps where business_id = $1`, [
    fresh.business,
  ]);
  const taskCap = async (): Promise<string | undefined> =>
    await fresh.db.app.withBusiness(fresh.business, async (tx) => await readBusinessCapId(tx));
  expect(await taskCap()).toBeUndefined();

  world.provider.mode('answer');
  expect(await plan(fresh, ownerOf(fresh), ask(fresh))).toMatchObject({ ok: true });
  const [planning] = await s.db.admin.execute<{ id: string }>(
    `select id from public.budget_caps where business_id = $1 and key = 'planning'`,
    [fresh.business],
  );
  expect(planning?.id).toEqual(expect.any(String));

  // Task work never draws on the planning allowance.
  expect(await taskCap()).toBeUndefined();
});
