// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  aiWorld,
  assign,
  created,
  minted,
  revisionOf,
  type AiWorld,
} from '../commands/ai-assign-world.ts';
import { ownedRankServer } from './task-rank-core-world.ts';

let world: AiWorld;
beforeAll(async () => {
  ownedRankServer();
  world = await aiWorld('p09_agent_lifecycle');
}, 180_000);
afterAll(async () => {
  await world?.world.drop();
});

it('the actual agent completion review and confirmation retain first-start evidence and completion neutralises age', async () => {
  const taskId = await created(world, world.p, 'Agent lifecycle');
  const command = async (name: string, extra: Readonly<Record<string, unknown>> = {}) => {
    const answer = await world.world.asPerson(world.p, {
      command: name,
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(world, taskId),
      ...extra,
    });
    if (isCommandRefusal(answer)) throw new Error(`${name} refused ${answer.code}`);
    return answer;
  };
  const read = async () =>
    await executeRead(world.world.db.app, world.world.business, world.p.presented, {
      read: 'task.read',
      recordId: taskId,
    });
  const startedAt = '2000-01-01T00:00:00.000Z';
  await command('task.start');
  await command('task.update', { fields: { started_at: startedAt } });
  await command('task.set_scores', { fields: { impact: 7, confidence: 9, ease: 8 } });
  expect(
    isCommandRefusal(
      await assign(world, world.p, taskId, { agent: await minted(world, world.p, taskId) }),
    ),
  ).toBe(false);
  const review = await command('task.complete');
  expect(review.detail).toMatchObject({ state: 'needs_review', completedAt: null });
  expect(await read()).toMatchObject({
    task: { startedAt, state: { machineCategory: 'unstarted' }, rank: { score: 756 } },
  });
  await command('task.complete');
  expect(await read()).toMatchObject({
    task: {
      startedAt,
      state: { machineCategory: 'completed' },
      rank: { score: 504, number: null },
    },
  });
});
