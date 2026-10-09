// SPDX-License-Identifier: AGPL-3.0-only

import { expect } from 'vitest';
import {
  readAuditEvents,
  type AuditEventRow,
} from '../../packages/core-commands/src/commands/audit.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import {
  appliedTask,
  rankCommand,
  readRankTask,
  type RankCoreWorld,
} from './task-rank-core-world.ts';

export async function completeRankStep(
  world: RankCoreWorld,
  taskId: string,
  startedAt: string | null | undefined,
): Promise<{ readonly stepId: string; readonly revision: number }> {
  const step = appliedTask(
    await rankCommand(world, {
      command: 'task.create',
      parentId: taskId,
      stateKey: 'active',
      fields: { title: 'A started step', started_at: startedAt },
    }),
  );
  const active = await readRankTask(world, taskId);
  const done = appliedTask(
    await rankCommand(world, {
      command: 'task.complete',
      recordId: taskId,
      expectedRevision: active.revision,
    }),
  );
  expect(await readRankTask(world, taskId)).toMatchObject({
    startedAt: startedAt,
    rank: { score: 504, number: null },
  });
  const archived = await readRankTask(world, step.id);
  expect(archived.startedAt).toBe(startedAt);
  expect(
    (await readRankTask(world, taskId)).steps.find((row) => row.id === step.id)?.archived,
  ).not.toBeNull();
  return { stepId: step.id, revision: done.revision };
}

export async function reopenRankStep(
  world: RankCoreWorld,
  taskId: string,
  startedAt: string | null | undefined,
  finished: { readonly stepId: string; readonly revision: number },
): Promise<void> {
  appliedTask(
    await rankCommand(world, {
      command: 'task.reopen',
      recordId: taskId,
      expectedRevision: finished.revision,
      reason: 'Lifecycle preservation',
    }),
  );
  expect(await readRankTask(world, taskId)).toMatchObject({
    startedAt: startedAt,
    rank: { score: 756 },
  });
  expect((await readRankTask(world, finished.stepId)).startedAt).toBe(startedAt);
  expect(
    (await readRankTask(world, taskId)).steps.find((row) => row.id === finished.stepId)?.archived,
  ).toBeNull();
}

async function rankFootprint(world: RankCoreWorld, taskId: string) {
  return await world.db.admin.execute<{
    readonly data: unknown;
    readonly revision: string;
    readonly operations: string;
  }>(
    'select data, revision::text as revision, (select count(*)::text from operations where business_id = $1) as operations from records where business_id = $1 and id = $2',
    [world.business, taskId],
  );
}

export async function assertRevokedRankReads(
  world: RankCoreWorld,
  taskId: string,
  startedAt: string | null | undefined,
): Promise<void> {
  const beforeDomain = await rankFootprint(world, taskId);
  expect(beforeDomain).toHaveLength(1);
  const beforeAudit = [...(await world.db.app.withBusiness(world.business, readAuditEvents))];
  const denied = await executeRead(world.db.app, world.business, world.reader.presented, {
    read: 'task.read',
    recordId: taskId,
  });
  expect(denied).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
  const board = await executeRead(world.db.app, world.business, world.reader.presented, {
    read: 'task.board',
    board: null,
  });
  expect(board).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
  expect(JSON.stringify([denied, board])).not.toContain(startedAt);
  expect(await rankFootprint(world, taskId)).toStrictEqual(beforeDomain);
  await assertRefusedAudit(world, beforeAudit);
}

async function assertRefusedAudit(world: RankCoreWorld, beforeAudit: readonly AuditEventRow[]) {
  const afterAudit = await world.db.app.withBusiness(world.business, readAuditEvents);
  expect(afterAudit.slice(0, beforeAudit.length)).toStrictEqual(beforeAudit);
  expect(afterAudit.slice(beforeAudit.length)).toMatchObject([
    {
      command: 'task.read',
      operation_id: null,
      actor_id: world.reader.actorId,
      outcome: 'refused',
      refusal_code: 'SCOPE_NOT_GRANTED',
    },
    {
      command: 'task.board',
      operation_id: null,
      actor_id: world.reader.actorId,
      outcome: 'refused',
      refusal_code: 'SCOPE_NOT_GRANTED',
    },
  ]);
  expect(afterAudit).toHaveLength(beforeAudit.length + 2);
}
