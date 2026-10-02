// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8 isolation: task category (CS-4.16), the crossings over the ad hoc
// world. Another business: its task is NOT_FOUND and keeps its label.
// Another client in the same business: clients A and B are real
// (`client.create`, each task placed under one by `task.set_party`); a writer
// granted client A's task cannot label client B's, and a reader of client A's
// task is served its category on the board and on `task.read` as it is the
// estimate (MP-5-8), never client B's. A party grant does not reach a task on
// this base (`readable-scope.ts`), so the grant is the task's own. The third
// crossing, an agent under a live delegation, is task-set-category-agent.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WHOLE_BUSINESS, enrol, grantTo } from './fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  CANARY,
  alpha,
  bravo,
  bravoWriter,
  clientAWriter,
  db,
  fresh,
  outcomeOf,
  serverUrl,
  setUp,
  tearDown,
  writer,
} from './adhoc-world.ts';
import {
  current,
  readCategory,
  realClient,
  setCategory,
  stored,
  underClient,
} from './category-support.ts';

if (serverUrl === undefined) {
  console.warn(
    'task-set-category-isolation: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

beforeAll(async () => {
  if (serverUrl === undefined) return;
  await setUp();
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, writer, 'share');
    await grantTo(tx, writer, 'write', WHOLE_BUSINESS, false, 'record');
  });
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

describe.skipIf(serverUrl === undefined)('MP-4-8 CS-4.16 task category', () => {
  describe('MP-4-8 isolation: task category', () => {
    it('another business: its task is not found, keeps its label and shows no canary', async () => {
      const foreign = await fresh(bravo, bravoWriter, CANARY);
      await setCategory(bravo, bravoWriter, foreign, 'videography');
      const before = await stored(foreign.recordId);
      const answer = await setCategory(alpha, writer, await current(foreign), 'seo');
      expect(outcomeOf(answer)).toMatchObject({ code: 'NOT_FOUND' });
      expect(JSON.stringify(answer)).not.toMatch(new RegExp(`${CANARY}|videography`, 'u'));
      expect(await stored(foreign.recordId)).toStrictEqual(before);
      expect(await readCategory(alpha, writer, foreign.recordId)).toBe('NOT_FOUND');
    });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-8 CS-4.16 task category', () => {
  describe('MP-4-8 isolation: task category, another client', () => {
    it('another client in the same business: a writer on client A cannot label client B’s task', async () => {
      const clientA = await realClient();
      const taskA = await underClient(clientA, 'client A');
      const taskB = await underClient(await realClient(), CANARY);
      await db.app.withBusiness(alpha, async (tx) => {
        await grantTo(tx, clientAWriter, 'write', { kind: 'record', id: taskA.recordId });
      });
      expect(outcomeOf(await setCategory(alpha, clientAWriter, taskA, 'admin'))).toStrictEqual({
        applied: true,
      });
      const refused = await setCategory(alpha, clientAWriter, taskB, 'admin');
      expect(outcomeOf(refused)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
      expect(JSON.stringify(refused)).not.toContain(CANARY);
      expect(await stored(taskB.recordId)).toStrictEqual({
        category: null,
        revision: taskB.revision,
      });
    });

    // The label is a task field like the estimate (MP-5-8): a reader of a task is
    // served it, on the board and on task.read, and never another client's.
    it('another client: a reader of client A’s task reads its category, never client B’s', async () => {
      const clientA = await realClient();
      const taskA = await underClient(clientA, 'client A labelled');
      const taskB = await underClient(await realClient(), CANARY);
      await setCategory(alpha, writer, taskA, 'reporting');
      await setCategory(alpha, writer, await current(taskB), 'videography');
      const taskReader = await enrol(db.app, alpha, 'task-reader');
      await db.app.withBusiness(alpha, async (tx) => {
        await grantTo(tx, taskReader, 'read', { kind: 'record', id: taskA.recordId });
      });
      const board = await executeRead(db.app, alpha, taskReader.presented, {
        read: 'task.board',
        board: null,
      });
      const rows = isCommandRefusal(board) || !('tasks' in board) ? [] : board.tasks;
      expect(rows.map((one) => [one.id, (one as { category?: unknown }).category])).toStrictEqual([
        [taskA.recordId, 'reporting'],
      ]);
      expect(JSON.stringify(board)).not.toMatch(new RegExp(`${CANARY}|videography`, 'u'));
      expect(await readCategory(alpha, taskReader, taskA.recordId)).toBe('reporting');
      expect(await readCategory(alpha, taskReader, taskB.recordId)).not.toBe('videography');
    });
  });
});
