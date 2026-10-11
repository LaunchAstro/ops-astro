// SPDX-License-Identifier: AGPL-3.0-only
// A reorder is a placement transition, whose board order the reader sees.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { agentWorld, type AgentWorld, type Decider } from '../commands/agent-fixture.ts';
import { eventsOf, made } from '../commands/field-changes-world.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';

let world: AgentWorld;
let writer: Decider;

const create = async (board?: string) =>
  made(
    await world.asPerson(writer, {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'reorder proof' },
      ...(board === undefined ? {} : { board }),
    }),
  );

/** The board's tasks, in the order `task.board` lists them. */
const boardOrder = async (board: string) => {
  const answer = await executeRead(world.db.app, world.business, writer.presented, {
    read: 'task.board',
    board,
  });
  if (isCommandRefusal(answer) || !('tasks' in answer)) throw new Error('board not answered');
  return answer.tasks.map((task) => task.id);
};

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a reorder is a placement transition in history',
  () => {
    beforeAll(async () => {
      world = await agentWorld('sol1214_rank', 'sol1214-rank');
      writer = await world.decider('reorder-writer');
    }, 120_000);
    afterAll(async () => {
      await world?.drop();
    });

    it('a visible reorder retains its history transition and lookup', async () => {
      const board = await create();
      const first = await create(board.recordId);
      const last = await create(board.recordId);
      expect(await boardOrder(board.recordId)).toStrictEqual([first.recordId, last.recordId]);
      const operationId = randomUUID();
      const moved = await world.asPerson(writer, {
        command: 'task.rank',
        operationId,
        recordId: last.recordId,
        expectedRevision: last.revision,
        beforeId: first.recordId,
      });
      expect(isCommandRefusal(moved)).toBe(false);
      expect(await boardOrder(board.recordId)).toStrictEqual([last.recordId, first.recordId]);
      const events = await eventsOf(world.db.admin, [operationId]);
      expect(events).toHaveLength(1);
      expect(events[0]?.field_changes).toStrictEqual({ version: 1, keys: ['board_rank'] });
      const eventId = events[0]?.row['id'];
      if (typeof eventId !== 'string') throw new Error('applied event missing');
      const answer = await executeRead(world.db.app, world.business, writer.presented, {
        read: 'task.read',
        recordId: last.recordId,
        historyEventId: eventId,
      });
      if (isCommandRefusal(answer) || !('task' in answer)) throw new Error('task not answered');
      expect.soft(answer.task.history.at(-1)).toMatchObject({
        eventId,
        operation: 'task.rank',
        actorId: writer.actorId,
      });
      expect.soft(answer.task.historyEvent).toMatchObject({ eventId, operation: 'task.rank' });
    });
  },
);
