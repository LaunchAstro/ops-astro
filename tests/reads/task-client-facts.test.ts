// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8: what the dock panel's Client field reads from `task.read`, against a
// real database. A member's detail names the client the task is under (by id,
// C32's client model) and whether the task has content, the S0-5 answer that
// locks the client. The field's names come from `client.list`, so the detail
// carries an id and never a client's name.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { grantTo } from '../commands/fixture.ts';
import { timeWorld, type TimeWorld } from '../commands/time-world.ts';
import { commandOk, madeClient } from '../commands/todo-support.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'task-client-facts: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

let w: TimeWorld;
const live = describe.skipIf(serverUrl === undefined);

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await timeWorld('tcf');
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    for (const action of ['assign', 'share'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one grant at a time
      await grantTo(tx, w.ada, action);
    }
  });
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

type Body = Readonly<Record<string, unknown>>;

async function detail(taskId: string): Promise<{ task: Body; body: string }> {
  const answer = await executeRead(w.db.app, w.alpha, w.ada.presented, {
    read: 'task.read',
    recordId: taskId,
  } as never);
  if (isCommandRefusal(answer) || !('task' in answer)) throw new Error('task.read refused');
  return { task: answer.task as unknown as Body, body: JSON.stringify(answer) };
}

live('MP-4-8 task.read names the task’s client for the Client field', () => {
  it('a task under no client reads client null; put under one, its id and never its name', async () => {
    const client = await madeClient(w, w.alpha, w.ada);
    const [row] = await w.db.admin.execute<{ readonly name: string }>(
      'select name from public.clients where id = $1',
      [client],
    );
    const name = String(row?.name);
    const taskId = await w.fresh(w.alpha, w.ada, 'Client field task');
    expect((await detail(taskId)).task['client']).toBeNull();
    await commandOk(w, w.alpha, w.ada, {
      command: 'task.set_party',
      recordId: taskId,
      fields: { client },
    });
    const after = await detail(taskId);
    expect(after.task['client']).toBe(client);
    expect(after.task['clientSet']).toBe(true);
    expect(after.body).not.toContain(name);
  });
});

live('MP-4-8 task.read answers whether the client is locked (S0-5 content)', () => {
  it('an empty task has no content; after a content write it has, as the lock decides', async () => {
    const client = await madeClient(w, w.alpha, w.ada);
    const taskId = await w.fresh(w.alpha, w.ada, 'Lock answer task');
    await commandOk(w, w.alpha, w.ada, {
      command: 'task.set_party',
      recordId: taskId,
      fields: { client },
    });
    // Creation and a client change are not content: the client can still change.
    expect((await detail(taskId)).task['hasContent']).toBe(false);
    await commandOk(w, w.alpha, w.ada, {
      command: 'task.assign',
      recordId: taskId,
      fields: { assignee: w.noah.personId },
    });
    expect((await detail(taskId)).task['hasContent']).toBe(true);
    // The read and the lock agree: the client change is now refused CLIENT_LOCKED.
    const other = await madeClient(w, w.alpha, w.ada);
    const refused = await w.as(w.alpha, w.ada, {
      command: 'task.set_party',
      recordId: taskId,
      expectedRevision: Number((await detail(taskId)).task['revision']),
      fields: { client: other },
    });
    expect(isCommandRefusal(refused) ? refused.code : 'applied').toBe('CLIENT_LOCKED');
  });
});
