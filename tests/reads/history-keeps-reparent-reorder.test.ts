// SPDX-License-Identifier: AGPL-3.0-only
// A reparent to the top level also assigns a fresh rank after the siblings.
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
      fields: { title: 'reparent order proof' },
      ...(board === undefined ? {} : { board }),
    }),
  );

async function order(board: string) {
  const answer = await executeRead(world.db.app, world.business, writer.presented, {
    read: 'task.board',
    board,
  });
  if (isCommandRefusal(answer) || !('tasks' in answer)) throw new Error('board not answered');
  return answer.tasks.map((task) => task.id);
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a reparent that reorders a board stays in history',
  () => {
    beforeAll(async () => {
      world = await agentWorld('sol1214_reparent', 'sol1214-reparent');
      writer = await world.decider('reparent-writer');
    }, 120_000);
    afterAll(async () => {
      await world?.drop();
    });

    it('a reparent that visibly reorders a board retains history and lookup', async () => {
      const board = await create();
      const first = await create(board.recordId);
      const last = await create(board.recordId);
      expect(await order(board.recordId)).toStrictEqual([first.recordId, last.recordId]);
      const operationId = randomUUID();
      const result = await world.asPerson(writer, {
        command: 'task.reparent',
        operationId,
        recordId: first.recordId,
        expectedRevision: first.revision,
        parentId: null,
      });
      expect(isCommandRefusal(result)).toBe(false);
      expect(await order(board.recordId)).toStrictEqual([last.recordId, first.recordId]);
      const events = await eventsOf(world.db.admin, [operationId]);
      expect(events).toHaveLength(1);
      expect(events[0]?.field_changes).toStrictEqual({ version: 1, keys: ['board_rank'] });
      const eventId = events[0]?.row['id'];
      if (typeof eventId !== 'string') throw new Error('applied event missing');
      const answer = await executeRead(world.db.app, world.business, writer.presented, {
        read: 'task.read',
        recordId: first.recordId,
        historyEventId: eventId,
      });
      if (isCommandRefusal(answer) || !('task' in answer)) throw new Error('task not answered');
      expect.soft(answer.task.history.at(-1)).toMatchObject({
        eventId,
        operation: 'task.reparent',
        actorId: writer.actorId,
      });
      expect.soft(answer.task.historyEvent).toMatchObject({ eventId, operation: 'task.reparent' });
    });
  },
);
