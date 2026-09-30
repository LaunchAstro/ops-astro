// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-1's read (CS-7.23): `task.todos`, the reader's own to-dos, through the
// read path against a real database. An open task assigned to the reader is
// listed whatever board it sits on; someone else's, an unassigned one, a
// completed one and a step archived by its parent's completion are not. Each
// row carries its tags and the count of client messages owed by the team.
// The crossings are in `task-todos-isolation.test.ts`.
//
// `task.todos` is `task:read` on the business, like the tag vocabulary: a
// reader held to one client's records is refused, and no agent reaches it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { codeOf } from './agent-fixture.ts';
import { grantTo, type Member } from './fixture.ts';
import { insertActor, insertPerson } from '../identity/fixture.ts';
import { WHOLE, timeWorld, type TimeWorld } from './time-world.ts';
import { assignTo, commandOk, todosOf } from './todo-support.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('task-todos: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

let w: TimeWorld;
const live = describe.skipIf(serverUrl === undefined);

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await timeWorld('td');
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    for (const member of [w.ada, w.noah]) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one grant at a time
      await grantTo(tx, member, 'assign');
      // eslint-disable-next-line no-await-in-loop -- one transaction, one grant at a time
      await grantTo(tx, member, 'write', WHOLE, false, 'tag');
      // eslint-disable-next-line no-await-in-loop -- one transaction, one grant at a time
      await grantTo(tx, member, 'comment');
    }
  });
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

describe('MP-7-1 task.todos is declared', () => {
  it('a read of task:read on the business that no agent reaches', () => {
    const found = COMMAND_SURFACE.find((each) => each.name === 'task.todos');
    expect([
      found?.kind,
      found?.collection,
      found?.action,
      found?.authorisedOn,
      found?.agent,
    ]).toStrictEqual(['read', 'task', 'read', 'business', 'never']);
  });
});

/** A client message from a person outside the business, owed a reply; and one from the team, not owed. */
async function owedMessage(taskId: string): Promise<void> {
  await commandOk(w, w.alpha, w.ada, {
    command: 'task.comment',
    recordId: taskId,
    body: 'from the client',
    audience: 'client',
  });
  await commandOk(w, w.alpha, w.ada, {
    command: 'task.comment',
    recordId: taskId,
    body: 'an internal note',
    audience: 'internal',
  });
  const outsider = await w.db.app.withBusiness(w.alpha, async (tx) =>
    insertActor(tx, await insertPerson(tx, `outsider ${randomUUID().slice(0, 8)}`)),
  );
  await w.db.admin.execute(
    `update public.records set data = jsonb_set(data, '{author}', to_jsonb($2::text))
      where data ->> 'task' = $1 and data ->> 'audience' = 'client'`,
    [taskId, outsider],
  );
  // The team's own client message is not acknowledged, and is not owed by the team.
  await commandOk(w, w.alpha, w.ada, {
    command: 'task.comment',
    recordId: taskId,
    body: 'from the team',
    audience: 'client',
  });
}

/** Ada's world: her open tasks, and the ones her list must leave out. */
async function adasWork() {
  const mine = await assignTo(w, w.alpha, w.ada, 'Ada’s brief', w.ada);
  const board = await w.fresh(w.alpha, w.ada, 'a board');
  const onBoard = await assignTo(w, w.alpha, w.ada, 'Ada’s board work', w.ada, { board });
  const noahs = await assignTo(w, w.alpha, w.ada, 'Noah’s work', w.noah);
  const unassigned = await w.fresh(w.alpha, w.ada, 'nobody’s work');
  const done = await assignTo(w, w.alpha, w.ada, 'Ada’s finished work', w.ada);
  await commandOk(w, w.alpha, w.ada, { command: 'task.complete', recordId: done });
  const parent = await w.fresh(w.alpha, w.noah, 'Noah’s parent');
  const step = await assignTo(w, w.alpha, w.ada, 'Ada’s archived step', w.ada, {
    parentId: parent,
  });
  await commandOk(w, w.alpha, w.noah, { command: 'task.complete', recordId: parent });
  return { mine, onBoard, left: [noahs, unassigned, done, step, parent, board] };
}

live('MP-7-1 my to-dos are my open tasks', () => {
  it('lists Ada’s open tasks on any board, and none of anyone else’s, finished or archived', async () => {
    const work = await adasWork();
    const tag = await commandOk(w, w.alpha, w.ada, { command: 'tag.create', name: 'Legal' });
    await commandOk(w, w.alpha, w.ada, {
      command: 'task.add_tag',
      recordId: work.mine,
      tagId: String(tag.detail?.['tagId']),
    });
    await owedMessage(work.mine);
    const { todos } = await todosOf(w, w.alpha, w.ada);
    const ids = todos.map((todo) => todo.id);
    expect(ids.toSorted()).toStrictEqual([work.mine, work.onBoard].toSorted());
    for (const left of work.left) expect(ids).not.toContain(left);
    const mine = todos.find((todo) => todo.id === work.mine);
    expect(mine?.title).toBe('Ada’s brief');
    expect(mine?.assignee?.personId).toBe(w.ada.personId);
    expect(mine?.tags.map((each) => each.name)).toStrictEqual(['Legal']);
    expect(mine?.waitingComments).toBe(1);
    expect(todos.find((todo) => todo.id === work.onBoard)?.waitingComments).toBe(0);
  });

  it('Noah reads his own, and not Ada’s', async () => {
    const his = await assignTo(w, w.alpha, w.ada, 'for Noah', w.noah);
    const hers = await assignTo(w, w.alpha, w.ada, 'for Ada', w.ada);
    const ids = (await todosOf(w, w.alpha, w.noah)).todos.map((todo) => todo.id);
    expect(ids).toContain(his);
    expect(ids).not.toContain(hers);
  });
});

live('MP-7-1 task:read refused', () => {
  it('a member holding no task:read on the business is refused, not answered empty', async () => {
    const member: Member = w.clientA;
    const answer = await executeRead(w.db.app, w.alpha, member.presented, {
      read: 'task.todos',
    } as never);
    expect(codeOf(answer as never)).toBe('SCOPE_NOT_GRANTED');
  });
});
