// SPDX-License-Identifier: AGPL-3.0-only
//
// #197: `task.move` answered 500 to a wrong-type board operand, where every
// other command refuses one with a typed 4xx. Each case drives the real route:
// the answer is a refusal under 500 that names the operand, and the task is
// left where it was.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, call, createWorld, personPath, serverUrl, type World } from './world.ts';

const asAda = async (world: World, name: string, body: Readonly<Record<string, unknown>>) =>
  await call(world.api, personPath('alpha', name), body, bearer(world.ada.token));

async function revisionOf(world: World, recordId: string): Promise<number> {
  const rows = await world.db.admin.execute<{ readonly revision: string }>(
    'select revision::text as revision from public.records where business_id = $1 and id = $2',
    [world.alpha, recordId],
  );
  return Number(rows[0]?.revision ?? '0');
}

const WRONG: readonly (readonly [string, Readonly<Record<string, unknown>>, string])[] = [
  ['board as a number', { board: 7 }, 'board'],
  ['board as true', { board: true }, 'board'],
  ['board as an object', { board: { id: 'b' } }, 'board'],
  ['board as a list', { board: ['b'] }, 'board'],
  ['boardSection as a number', { board: null, boardSection: 7 }, 'board_section'],
  ['boardSection as an object', { board: null, boardSection: { id: 's' } }, 'board_section'],
];

if (serverUrl === undefined) {
  console.warn('acceptance/task-move-operand-types: DATABASE_URL is unset, so nothing ran.');
}

describe.skipIf(serverUrl === undefined)('task.move refuses a wrong-type board operand', () => {
  let world: World;
  let taskId: string;

  beforeAll(async () => {
    world = await createWorld('movetype');
    const created = await asAda(world, '/task/create', {
      operationId: randomUUID(),
      fields: { title: `a task to move ${randomUUID()}` },
    });
    expect(created.code, 'create').toBe('ok');
    taskId = String(created.body['recordId']);
  }, 120_000);

  afterAll(async () => {
    await world?.close();
  });

  it.each(WRONG)(
    '%s: a typed refusal, not a 500',
    async (_name, operands, named) => {
      const before = await revisionOf(world, taskId);
      const answer = await asAda(world, '/task/move', {
        operationId: randomUUID(),
        recordId: taskId,
        expectedRevision: before,
        ...operands,
      });
      expect(answer.status, JSON.stringify(answer.body)).toBeGreaterThanOrEqual(400);
      expect(answer.status).toBeLessThan(500);
      expect(answer.body['refused']).toBe(true);
      expect(JSON.stringify(answer.body['names'] ?? [])).toMatch(
        new RegExp(named.replace('_', '_?'), 'iu'),
      );
      expect(await revisionOf(world, taskId), 'the task did not move').toBe(before);
    },
    60_000,
  );
});
