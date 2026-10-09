// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { useMoveWorld } from '../onboarding/c41-a-move-world.ts';
import { ownedRankServer } from './task-rank-core-world.ts';

ownedRankServer();
const world = useMoveWorld('p09_onboarding_lifecycle');
it('canonical onboarding-created task steps retain an absent first-start date before work begins', async () => {
  const steps = await world.onboard('Synthetic lifecycle onboarding');
  expect(steps.size).toBeGreaterThan(0);
  const { fixture } = world.the.controls;
  await Promise.all(
    [...steps.values()].map(async (taskId) => {
      const answer = await executeRead(
        fixture.db.app,
        fixture.business,
        world.the.admin.presented,
        { read: 'task.read', recordId: taskId },
      );
      expect(answer).toMatchObject({
        task: { startedAt: null, state: { machineCategory: 'unstarted' } },
      });
      const [stored] = await fixture.db.admin.execute<{ readonly started: string | null }>(
        "select data ->> 'started_at' as started from records where business_id = $1 and id = $2",
        [fixture.business, taskId],
      );
      expect(stored?.started).toBeNull();
    }),
  );
});
