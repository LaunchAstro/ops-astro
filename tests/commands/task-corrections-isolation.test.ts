// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-14 isolation: the finished task the corrections draw is read through
// task.read and nothing else, so another business's finished task and another
// client's are never read through it, and a refusal echoes nothing of either.
// The third crossing, another person's task under a live delegation, is
// task-corrections-agent.test.ts. MP-4-14 adds no read or command of its own.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantTo } from './fixture.ts';
import {
  CANARY,
  alpha,
  as,
  bravo,
  bravoEditor,
  clientA,
  clientAEditor,
  clientB,
  db,
  editor,
  fresh,
  outcomeOf,
  readAs,
  rowOf,
  serverUrl,
  setUp,
  tearDown,
} from './panel-fields-world.ts';

if (serverUrl === undefined) {
  console.warn(
    'task-corrections-isolation: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp('hm');
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

const finished = async (
  business: typeof alpha,
  by: typeof editor,
  title: string,
  client: string | null = null,
): Promise<string> => {
  const id = await fresh(business, by, title, client);
  const done = await as(business, by, {
    command: 'task.complete',
    recordId: id,
    expectedRevision: (await rowOf(id))?.revision,
  });
  if ('code' in outcomeOf(done)) throw new Error('complete refused');
  return id;
};

describe.skipIf(serverUrl === undefined)('MP-4-14 isolation', () => {
  it('another business: its finished task is not found and nothing of it is echoed', async () => {
    const foreign = await finished(bravo, bravoEditor, CANARY);
    const read = await readAs(alpha, editor, foreign);
    expect(outcomeOf(read)).toStrictEqual({ code: 'NOT_FOUND' });
    expect(JSON.stringify(read)).not.toContain(CANARY);
  });

  it('another client in the same business: client A’s reader reads client A’s finished task only', async () => {
    const taskA = await finished(alpha, editor, 'client A done', clientA);
    const taskB = await finished(alpha, editor, CANARY, clientB);
    await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, clientAEditor, 'read', { kind: 'record', id: taskA });
    });
    const own = await readAs(alpha, clientAEditor, taskA);
    expect('task' in own ? own.task.state?.machineCategory : null).toBe('completed');
    const cross = await readAs(alpha, clientAEditor, taskB);
    expect(outcomeOf(cross)).toStrictEqual({ code: 'SCOPE_NOT_GRANTED' });
    expect(JSON.stringify(cross)).not.toContain(CANARY);
  });
});
