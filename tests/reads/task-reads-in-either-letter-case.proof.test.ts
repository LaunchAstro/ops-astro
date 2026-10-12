// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readTaskRank } from '../../packages/core-commands/src/reads/rank.ts';
import { readTaskFamily } from '../../packages/core-records/src/tasks/family.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { readSharedTask } from '../../packages/core-commands/src/reads/tasks.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  alpha,
  clientAViewer,
  command,
  db,
  ids,
  owner,
  revisionOf,
  serverUrl,
  setUp,
  tearDown,
} from './rank-world.ts';

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);
afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

async function taskType(id: string): Promise<string> {
  const [row] = await db.admin.execute<{ record_type_id: string }>(
    'select record_type_id from public.records where id = $1',
    [id],
  );
  if (row === undefined) throw new Error('The seeded task is missing');
  return row.record_type_id;
}

it.skipIf(serverUrl === undefined)('uppercase UUIDs preserve the direct task rank', async () => {
  const id = ids['a504'];
  if (id === undefined) throw new Error('The scored task is missing');
  expect(id.toUpperCase()).not.toBe(id);
  const type = await taskType(id);
  const read = async (spelling: string) =>
    await db.app.withBusiness(
      alpha,
      async (tx) => await readTaskRank(tx, type, spelling, { kind: 'task' }),
    );
  const lower = await read(id);
  expect(lower).toMatchObject({ number: 1, score: 504 });
  expect(await read(id.toUpperCase())).toStrictEqual(lower);
});

it.skipIf(serverUrl === undefined)(
  'uppercase UUIDs preserve the family parent and child set',
  async () => {
    const id = ids['a504'];
    if (id === undefined) throw new Error('The parent task is missing');
    const type = await taskType(id);
    const read = async (spelling: string) =>
      await db.app.withBusiness(alpha, async (tx) => await readTaskFamily(tx, type, spelling, []));
    const lower = await read(id);
    expect(lower.parent?.id).toBe(id);
    expect(lower.children).toHaveLength(0);
    expect(await read(id.toUpperCase())).toStrictEqual(lower);
  },
);

const readBoard = async (board: string) =>
  await executeRead(db.app, alpha, clientAViewer.presented, { read: 'task.board', board });

it.skipIf(serverUrl === undefined)(
  'uppercase UUIDs admit the same record-scoped board',
  async () => {
    const id = ids['a504'];
    if (id === undefined) throw new Error('The board task is missing');
    const lower = await readBoard(id);
    expect(lower).toHaveProperty('ok', true);
    expect(await readBoard(id.toUpperCase())).toStrictEqual(lower);
  },
);

it.skipIf(serverUrl === undefined)(
  'uppercase UUIDs preserve client comments in the shared task read',
  async () => {
    const id = ids['a504'];
    if (id === undefined) throw new Error('The shared task is missing');
    await db.app.withBusiness(alpha, async (tx) => await grantTo(tx, owner, 'comment'));
    await command(alpha, owner, {
      command: 'task.comment',
      recordId: id,
      expectedRevision: await revisionOf(id),
      body: 'Client-visible case proof',
      audience: 'client',
    });
    const type = await taskType(id);
    const [commentType] = await db.admin.execute<{ id: string }>(
      "select id from public.record_types where business_id = $1 and key = 'task_comment'",
      [alpha],
    );
    if (commentType === undefined) throw new Error('The comment type is missing');
    const read = async (spelling: string) =>
      await db.app.withBusiness(
        alpha,
        async (tx) => await readSharedTask(tx, type, spelling, commentType.id),
      );
    const lower = await read(id);
    expect(lower?.comments).toHaveLength(1);
    expect((await read(id.toUpperCase()))?.comments).toStrictEqual(lower?.comments);
  },
);
