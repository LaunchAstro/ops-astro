// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { agentWorld, type AgentWorld } from '../commands/agent-fixture.ts';
import { ownedRankServer } from './task-rank-core-world.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';

let world: AgentWorld | undefined;
beforeAll(async () => {
  ownedRankServer();
  world = await agentWorld('orch172_rankcore_agent', `rankcore-agent-${randomUUID().slice(0, 8)}`);
}, 180_000);
afterAll(async () => {
  await world?.drop();
});

async function datedDelegate(w: AgentWorld) {
  const person = await w.decider('rankcore-decider');
  const sibling = await w.asPerson(person, {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title: 'rankcore-OTHER-TASK-CANARY' },
  });
  if (isCommandRefusal(sibling))
    throw new Error(`Synthetic sibling refused ${sibling.code}: ${sibling.names.join(', ')}`);
  if (sibling.recordId === null) throw new Error('No synthetic sibling created');
  const picked = await w.pickUp(person, 'Rank core delegated task');
  const revision = async (): Promise<number> =>
    Number(
      (
        await w.db.admin.execute<{ readonly revision: string }>(
          'select revision::text as revision from public.records where id = $1',
          [picked.taskId],
        )
      )[0]?.revision,
    );
  const marked = await w.asPerson(person, {
    command: 'task.set_scores',
    operationId: randomUUID(),
    recordId: picked.taskId,
    expectedRevision: await revision(),
    fields: { impact: 7, confidence: 9, ease: 8 },
  });
  expect(isCommandRefusal(marked)).toBe(false);
  const dated = await w.asPerson(person, {
    command: 'task.update',
    operationId: randomUUID(),
    recordId: picked.taskId,
    expectedRevision: await revision(),
    fields: { started_at: new Date(Date.now() - 10 * 86_400_000).toISOString() },
  });
  expect(isCommandRefusal(dated)).toBe(false);
  return { picked, siblingId: sibling.recordId, revision };
}

it('a delegated agent receives its real aged rank from its one-task pool and cannot read a sibling or edit the start date', async () => {
  if (world === undefined) throw new Error('Owned rank agent world not prepared');
  const w = world;
  const { picked, siblingId, revision } = await datedDelegate(w);
  const answer = await w.asAgent(
    { command: 'task.read', recordId: picked.taskId, operationId: randomUUID() },
    picked.credential,
  );
  expect(answer).toMatchObject({
    detail: {
      task: {
        rank: {
          number: 1,
          score: 529,
          calc: 'impact 7 × confidence 9 × ease 8 × priority 1 × age 1.05 (1 week) = 529 · derived',
        },
      },
    },
  });
  const outside = await w.asAgent(
    { command: 'task.read', recordId: siblingId, operationId: randomUUID() },
    picked.credential,
  );
  expect(outside).toMatchObject({ refused: true });
  expect(JSON.stringify([answer, outside])).not.toContain('rankcore-OTHER-TASK-CANARY');
  const edit = await w.asAgent(
    {
      command: 'task.update',
      recordId: picked.taskId,
      expectedRevision: await revision(),
      fields: { started_at: null },
      operationId: randomUUID(),
    },
    picked.credential,
  );
  expect(edit).toMatchObject({ refused: true });
  const unchanged = await w.asAgent(
    { command: 'task.read', recordId: picked.taskId, operationId: randomUUID() },
    picked.credential,
  );
  expect(unchanged).toMatchObject({ detail: { task: { rank: { number: 1, score: 529 } } } });
});
