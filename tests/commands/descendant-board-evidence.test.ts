// SPDX-License-Identifier: AGPL-3.0-only
//
// #1207: a move or reparent carries the new board down the task's subtree, and
// every record whose board it changed gets an applied audit event of its own,
// naming `board`, in the mover's business. Each descendant's own history then
// shows the move and who made it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { agentWorld, type AgentWorld, type Decider } from './agent-fixture.ts';
import { eventsOf, made, taskRow, type Made } from './field-changes-world.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { HistoryEntry } from '../../packages/core-wire/src/index.ts';

const configured = databaseUrlFromEnvironment() !== undefined;

type Body = Readonly<Record<string, unknown>>;

let world: AgentWorld;
let mover: Decider;

const create = async (operands: Body) =>
  made(
    await world.asPerson(mover, {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'carried' },
      ...operands,
    }),
  );

const historyOf = async (recordId: string): Promise<readonly HistoryEntry[]> => {
  const answer = await executeRead(world.db.app, world.business, mover.presented, {
    read: 'task.read',
    recordId,
  } as never);
  if (isCommandRefusal(answer) || !('task' in answer)) throw new Error('task not answered');
  return answer.task.history;
};

/** A parent on `board` with a child and a grandchild under it. */
const subtree = async (board: Made) => {
  const root = await create({ board: board.recordId });
  const child = await create({ parentId: root.recordId });
  const grandchild = await create({ parentId: child.recordId });
  return { root, descendants: [child, grandchild] };
};

/**
 * Every descendant is on `board` at a later revision, and has one applied
 * event of the operation naming `board` alone, which its history lists last.
 */
async function expectCarried(
  operationId: string,
  command: string,
  descendants: readonly Made[],
  board: string,
): Promise<void> {
  const events = await eventsOf(world.db.admin, [operationId]);
  for (const { recordId: id, revision } of descendants) {
    // eslint-disable-next-line no-await-in-loop -- one descendant at a time, for a readable failure
    const row = await taskRow(world.db.admin, id);
    expect((row['data'] as Body)['board']).toBe(board);
    expect(Number(row['revision'])).toBeGreaterThan(revision);
    const own = events.filter((event) => event.row['subject_record_id'] === id);
    expect(own.map((event) => [event.business_id, event.outcome, event.command])).toStrictEqual([
      [world.business, 'applied', command],
    ]);
    expect(own[0]?.field_changes).toStrictEqual({ version: 1, keys: ['board'] });
    // eslint-disable-next-line no-await-in-loop
    expect((await historyOf(id)).at(-1)).toMatchObject({
      eventId: own[0]?.row['id'],
      operation: command,
      changed: ['board'],
      actorId: mover.actorId,
    });
  }
  expect(events.every((event) => event.business_id === world.business)).toBe(true);
}

describe.skipIf(!configured)('a carried board leaves evidence on every descendant', () => {
  beforeAll(async () => {
    world = await agentWorld('desc_board', 'desc-board');
    mover = await world.decider('mover');
  }, 90_000);
  afterAll(async () => {
    await world?.drop();
  });

  it('task.move gives each descendant its own applied event naming board', async () => {
    const [from, to] = [await create({}), await create({})];
    const { root, descendants } = await subtree(from);
    const operationId = randomUUID();
    const moved = await world.asPerson(mover, {
      command: 'task.move',
      operationId,
      recordId: root.recordId,
      expectedRevision: root.revision,
      board: to.recordId,
    });
    expect(isCommandRefusal(moved)).toBe(false);
    await expectCarried(operationId, 'task.move', descendants, to.recordId);
  });

  it('task.reparent onto another board does the same for the subtree it carries', async () => {
    const [from, to] = [await create({}), await create({})];
    const { root, descendants } = await subtree(from);
    const parent = await create({ board: to.recordId });
    const operationId = randomUUID();
    const placed = await world.asPerson(mover, {
      command: 'task.reparent',
      operationId,
      recordId: root.recordId,
      expectedRevision: root.revision,
      parentId: parent.recordId,
    });
    expect(isCommandRefusal(placed)).toBe(false);
    await expectCarried(operationId, 'task.reparent', descendants, to.recordId);
  });

  it('the audit chain still verifies', async () => {
    expect(await world.db.app.withBusiness(world.business, verifyAuditChain)).toMatchObject({
      intact: true,
    });
  });
});
