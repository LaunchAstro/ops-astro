// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-2's scopes on `task.todos` (CS-7.4), through the read path against a
// real database: a teammate's open tasks (`person`) and a client's
// (`client`), each read under the same `task:read` of the business as the
// reader's own list, with no new key. A scope names one person or one
// client; a malformed or doubled scope is refused, and a person who is not a
// member here is not found. The crossings are in
// `task-todos-scope-isolation.test.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { codeOf } from './agent-fixture.ts';
import { grantTo, type Member } from './fixture.ts';
import { timeWorld, type TimeWorld } from './time-world.ts';
import { assignTo, commandOk, madeClient, todosOf } from './todo-support.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'task-todos-scope: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

let w: TimeWorld;
const live = describe.skipIf(serverUrl === undefined);

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await timeWorld('tds');
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

const ids = async (member: Member, scope: Record<string, unknown>) =>
  (await todosOf(w, w.alpha, member, scope)).todos.map((todo) => todo.id).toSorted();

async function refusalOf(member: Member, scope: Record<string, unknown>) {
  const answer = await executeRead(w.db.app, w.alpha, member.presented, {
    read: 'task.todos',
    ...scope,
  } as never);
  return { code: codeOf(answer as CommandResult), text: JSON.stringify(answer) };
}

live('MP-7-2 scope to a person', () => {
  it('a teammate’s scope lists that person’s open tasks, and nobody else’s', async () => {
    const his = await assignTo(w, w.alpha, w.ada, 'Noah’s brief', w.noah);
    const hers = await assignTo(w, w.alpha, w.ada, 'Ada’s brief', w.ada);
    const done = await assignTo(w, w.alpha, w.ada, 'Noah’s finished work', w.noah);
    await commandOk(w, w.alpha, w.ada, { command: 'task.complete', recordId: done });
    const list = await todosOf(w, w.alpha, w.ada, { person: w.noah.personId });
    expect(list.todos.map((todo) => todo.id)).toContain(his);
    expect(list.todos.map((todo) => todo.id)).not.toContain(hers);
    expect(list.todos.map((todo) => todo.id)).not.toContain(done);
    expect(new Set(list.todos.map((todo) => todo.assignee?.personId))).toStrictEqual(
      new Set([w.noah.personId]),
    );
    // Asking for yourself is your own list; the unscoped read is unchanged.
    expect(await ids(w.ada, { person: w.ada.personId })).toStrictEqual(await ids(w.ada, {}));
    // Any holder of task:read on the business reads it, whatever else they hold.
    expect(await ids(w.taskOnly, { person: w.noah.personId })).toContain(his);
  });

  it('a person who is not a member here is not found, and nothing is listed', async () => {
    const unknown = await refusalOf(w.ada, { person: randomUUID() });
    expect(unknown.code).toBe('NOT_FOUND');
    expect(unknown.text).not.toContain('todos');
  });
});

live('MP-7-2 scope to a client', () => {
  it('lists every open task under that client, whoever holds it, and none of another', async () => {
    const clientX = await madeClient(w, w.alpha, w.ada);
    const clientY = await madeClient(w, w.alpha, w.ada);
    const adas = await assignTo(w, w.alpha, w.ada, 'X for Ada', w.ada, {}, clientX);
    const noahs = await assignTo(w, w.alpha, w.ada, 'X for Noah', w.noah, {}, clientX);
    const unassigned = await w.fresh(w.alpha, w.ada, 'X for nobody');
    await commandOk(w, w.alpha, w.ada, {
      command: 'task.set_party',
      recordId: unassigned,
      fields: { client: clientX },
    });
    const other = await assignTo(w, w.alpha, w.ada, 'Y for Ada', w.ada, {}, clientY);
    const done = await assignTo(w, w.alpha, w.ada, 'X finished', w.ada, {}, clientX);
    await commandOk(w, w.alpha, w.ada, { command: 'task.complete', recordId: done });
    expect(await ids(w.ada, { client: clientX })).toStrictEqual(
      [adas, noahs, unassigned].toSorted(),
    );
    expect(await ids(w.ada, { client: clientY })).toStrictEqual([other]);
    // A client with nothing here is an empty list: there is no client record to find.
    expect(await ids(w.ada, { client: randomUUID() })).toStrictEqual([]);
  });
});

live('MP-7-2 a scope is one person or one client, well formed', () => {
  it('refuses both at once, a malformed identifier, and a number, naming the field', async () => {
    const cases = [
      [{ person: w.noah.personId, client: randomUUID() }, 'client'],
      [{ person: 'noah' }, 'person'],
      [{ client: 'T-1' }, 'client'],
      [{ person: 7 }, 'person'],
    ] as const;
    for (const [scope, field] of cases) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      const answer = await executeRead(w.db.app, w.alpha, w.ada.presented, {
        read: 'task.todos',
        ...scope,
      } as never);
      expect(answer, JSON.stringify(scope)).toMatchObject({
        code: 'FIELD_VALUE_INVALID',
        names: [field],
      });
    }
  });

  it('a member holding no task:read is refused before any person is looked up', async () => {
    const answer = await refusalOf(w.clientA, { person: randomUUID() });
    expect(answer.code).toBe('SCOPE_NOT_GRANTED');
  });
});
