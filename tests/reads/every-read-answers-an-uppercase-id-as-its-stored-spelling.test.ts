// SPDX-License-Identifier: AGPL-3.0-only
//
// A uuid operand is one id in either letter case. Every read that takes a task,
// a person or a board by id answers its uppercase spelling with the same body
// as its stored lowercase one, echoed ids included, so no read further in sees
// a second spelling. Site-by-site fixes kept missing the next read; this sweep
// asks each one through the read door.

import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { ReadRequest } from '../../packages/core-commands/src/reads/requests.ts';
import { alpha, db, ids, owner, serverUrl, setUp, tearDown } from './rank-world.ts';

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);
afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

const upper = (request: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(
    Object.entries(request).map(([key, value]) =>
      key !== 'read' && typeof value === 'string' ? [key, value.toUpperCase()] : [key, value],
    ),
  );

const ask = async (request: Readonly<Record<string, unknown>>) =>
  await executeRead(db.app, alpha, owner.presented, request as unknown as ReadRequest);

it.skipIf(serverUrl === undefined)(
  'every task, person and board read answers an uppercase id as its lowercase one',
  async () => {
    const task = ids['a504'];
    if (task === undefined) throw new Error('The seeded task is missing');
    const requests = [
      { read: 'task.read', recordId: task },
      { read: 'task.execution', recordId: task },
      { read: 'trace.read', recordId: task },
      { read: 'task.board', board: task },
      { read: 'task.board', board: null, person: owner.personId },
      { read: 'task.todos', person: owner.personId },
    ];
    for (const request of requests) {
      // oxlint-disable-next-line no-await-in-loop -- one read at a time reads as a list
      const lower = await ask(request);
      expect(lower, request.read).not.toMatchObject({ code: 'COMMAND_BODY_INVALID' });
      // oxlint-disable-next-line no-await-in-loop
      expect(await ask(upper(request)), JSON.stringify(request)).toStrictEqual(lower);
    }
  },
  120_000,
);
