// SPDX-License-Identifier: AGPL-3.0-only
//
// A task's history lists a change to what blocks it, which records only
// `blocked_by`, and lists a placement only when it changed something: a move
// onto the board the task is already on is not a change, and a reorder that
// changes only the rank is one.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { agentWorld, type AgentWorld, type Decider } from '../commands/agent-fixture.ts';
import { made, type Made } from '../commands/field-changes-world.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { HistoryEntry } from '../../packages/core-wire/src/index.ts';

const configured = databaseUrlFromEnvironment() !== undefined;

type Body = Readonly<Record<string, unknown>>;

// eslint-disable-next-line max-lines-per-function -- one world, the cases on it in order
describe.skipIf(!configured)('task history lists blocking changes and real placements', () => {
  let world: AgentWorld;
  let mia: Decider;

  beforeAll(async () => {
    world = await agentWorld('history_placed', 'history-placed');
    mia = await world.decider('Mia');
  }, 120_000);
  afterAll(async () => {
    await world?.drop();
  });

  const read = async (recordId: string, extra: Body = {}) =>
    await executeRead(world.db.app, world.business, mia.presented, {
      read: 'task.read',
      recordId,
      ...extra,
    } as never);
  const historyOf = async (recordId: string): Promise<readonly HistoryEntry[]> => {
    const answer = await read(recordId);
    if (isCommandRefusal(answer) || !('task' in answer)) throw new Error('task not answered');
    return answer.task.history;
  };
  const create = async (operands: Body = {}) =>
    made(
      await world.asPerson(mia, {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: 'placed' },
        ...operands,
      }),
    );
  const sent = async (task: Made, command: string, operands: Body) => {
    const answer = await world.asPerson(mia, {
      command,
      operationId: randomUUID(),
      recordId: task.recordId,
      expectedRevision: task.revision,
      ...operands,
    });
    expect(isCommandRefusal(answer)).toBe(false);
  };

  it('a change to what blocks a ticket is listed, and found by its lookup', async () => {
    const map = await create({ taskType: 'map' });
    const blocker = await create({ parentId: map.recordId, taskType: 'research' });
    const blocked = await create({ parentId: map.recordId, taskType: 'research' });
    await sent(blocked, 'task.set_blocking', { blockedBy: [blocker.recordId] });
    const entry = (await historyOf(blocked.recordId)).at(-1);
    expect(entry).toMatchObject({ operation: 'task.set_blocking', changed: ['blocked_by'] });
    const found = await read(blocked.recordId, { historyEventId: entry?.eventId });
    expect(found).toHaveProperty('task.historyEvent', entry);
  });

  it('a move to the board the task is already on is not listed', async () => {
    const board = await create();
    const task = await create({ board: board.recordId });
    const before = await historyOf(task.recordId);
    await sent(task, 'task.move', { board: board.recordId });
    expect(await historyOf(task.recordId)).toStrictEqual(before);
  });

  it('a reorder that changes only the rank is listed', async () => {
    const board = await create();
    const first = await create({ board: board.recordId });
    const second = await create({ board: board.recordId });
    await sent(second, 'task.rank', { beforeId: first.recordId });
    const latest = (await historyOf(second.recordId)).at(-1);
    expect(latest).toMatchObject({ operation: 'task.rank' });
    expect(latest).not.toHaveProperty('changed');
  });
});
