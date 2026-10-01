// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8 "Duplicate without contents" (CS-4.12, owner line 75): once a task has
// content its client is locked, and `task.duplicate` starts one for another
// client from the shell the person sent: the edited title and the step names,
// nothing else. This file holds the shell case; who may duplicate, the carried
// text warning and the way back are task-duplicate-access.test.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  CANARY,
  CLIENT_A_NAME,
  alpha,
  as,
  boardOf,
  clientA,
  clientB,
  db,
  detailOf,
  duplicate,
  newTaskOf,
  outcomeOf,
  owner,
  revisionOf,
  serverUrl,
  setUp,
  taskFor,
  tearDown,
} from './duplicate-world.ts';
import { DECLARED, NAME_FIELDS, contentKinds, plantEvery } from './duplicate-kinds.ts';

if (serverUrl === undefined) {
  console.warn(
    'task-duplicate: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

/** A client A task with a canary in every kind this base can plant, a step included. */
async function plantedTask(): Promise<string> {
  const old = await taskFor(alpha, owner, 'Spring launch', clientA);
  const step = await as(alpha, owner, {
    command: 'task.create',
    fields: { title: `${CANARY} step` },
    parentId: old,
  });
  expect(outcomeOf(step)).toStrictEqual({ applied: true });
  const planted = await plantEvery(old);
  for (const [kind, answer] of planted) {
    expect(outcomeOf(answer), kind).toStrictEqual({ applied: true });
  }
  expect(planted.length).toBeGreaterThan(8);
  return old;
}

/** The new task holds the shell and the server's own placement, nothing of the old. */
async function expectShellOnly(taskId: string): Promise<void> {
  const [stored] = await db.admin.execute<{ readonly data: Record<string, unknown> }>(
    `select data from public.records where id = $1`,
    [taskId],
  );
  expect(Object.keys(stored?.data ?? {}).toSorted()).toStrictEqual(
    ['board_rank', 'client', 'key', 'source', 'state', 'title'].toSorted(),
  );
  expect([stored?.data['title'], stored?.data['client']]).toStrictEqual(['Autumn launch', clientB]);
  const read = await detailOf(owner, taskId);
  const task = isCommandRefusal(read) || !('task' in read) ? undefined : read.task;
  expect(task?.steps.map((one) => one.title)).toStrictEqual(['Draft the brief', 'Book the shoot']);
  expect([task?.assignee, task?.description, task?.stage, task?.adHoc]).toStrictEqual([
    null,
    null,
    null,
    false,
  ]);
  expect([task?.comments.length, task?.tags.length]).toStrictEqual([0, 0]);
  expect(task?.history.map((one) => one.operation)).toStrictEqual(['task.duplicate']);
  const board = await boardOf(owner);
  const rows = isCommandRefusal(board) || !('tasks' in board) ? [] : board.tasks;
  const row = rows.find((one: { id: string }) => one.id === taskId);
  expect(row).toBeDefined();
  for (const body of [read, row]) expect(JSON.stringify(body)).not.toContain(CANARY.slice(0, 40));
}

describe.skipIf(serverUrl === undefined)('MP-4-8 duplicate carries only the shell', () => {
  it('MP-4-8 duplicate carries only the shell', async () => {
    // Every kind the catalogue has is declared, and nothing declared is not a kind.
    const kinds = contentKinds();
    expect(kinds.filter((kind) => DECLARED[kind] === undefined)).toStrictEqual([]);
    expect(Object.keys(DECLARED).filter((kind) => !kinds.includes(kind))).toStrictEqual([]);
    expect(kinds).toContain('task.duplicate');

    const old = await plantedTask();
    const oldBefore = await revisionOf(old);
    const made = await duplicate(owner, {
      recordId: old,
      client: clientB,
      title: 'Autumn launch',
      stepNames: ['Draft the brief', 'Book the shoot'],
    });
    expect(outcomeOf(made)).toStrictEqual({ applied: true });
    const { taskId, key } = newTaskOf(made);
    expect(key).toMatch(/^[A-Z]+-\d+$/u);
    expect(await revisionOf(old)).toBe(oldBefore);
    await expectShellOnly(taskId);
  });

  it.each(NAME_FIELDS)(
    'MP-4-8 carried name field %s: its canary goes only where sent',
    async (field) => {
      const old = await taskFor(alpha, owner, `${CANARY} named`, clientA);
      const sent = (text: string) =>
        field === 'title'
          ? { title: text, stepNames: [] }
          : { title: 'fresh', stepNames: ['ok', text] };
      const { taskId } = newTaskOf(
        await duplicate(owner, { recordId: old, client: clientB, ...sent(`${CANARY} kept`) }),
      );
      // What the person sent is what is written, canary and all; nothing else.
      expect(JSON.stringify(await detailOf(owner, taskId)).split(CANARY).length - 1).toBe(1);
      const named = await duplicate(owner, {
        recordId: old,
        client: clientB,
        ...sent(`ask ${CLIENT_A_NAME}`),
      });
      expect(outcomeOf(named)).toStrictEqual({
        code: 'CARRIED_TEXT_NAMES_CLIENT',
        names: [field === 'title' ? 'title' : 'stepNames.1'],
      });
    },
  );
});
