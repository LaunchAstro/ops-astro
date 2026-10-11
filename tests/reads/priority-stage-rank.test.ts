// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  priorityWorld,
  priorityTask,
  priorityApplied,
  readPriority,
  setPriority,
} from '../commands/priority-stages-support.ts';
import {
  readRankTask,
  readRankBoard,
  dateRankTask,
  type RankCoreWorld,
} from './task-rank-core-world.ts';

let world: RankCoreWorld | undefined;
function here(): RankCoreWorld {
  if (world === undefined) throw new Error('P10 owned rank database is not prepared');
  return world;
}
beforeAll(async () => {
  world = await priorityWorld();
}, 180_000);
afterAll(async () => {
  await world?.db.drop();
});

it('authoritative priority write changes page and board from 504 to 630; clear restores 504', async () => {
  const w = here();
  priorityApplied(await setPriority(w, [], (await readPriority(w)).revision));
  const made = await priorityTask(w, 'trust');
  expect((await readRankTask(w, made.id)).rank.score).toBe(504);
  priorityApplied(await setPriority(w, ['trust'], (await readPriority(w)).revision));
  expect(await readPriority(w)).toMatchObject({ value: ['trust'] });
  const task = await readRankTask(w, made.id);
  expect(task.rank).toMatchObject({
    score: 630,
    calc: 'impact 7 × confidence 9 × ease 8 × priority 1.25 × age 1 = 630 · derived',
  });
  expect((await readRankBoard(w)).tasks.find((row) => row.id === made.id)?.rank).toStrictEqual(
    task.rank,
  );
  priorityApplied(await setPriority(w, [], (await readPriority(w)).revision));
  const cleared = await readRankTask(w, made.id);
  expect(cleared.rank.score).toBe(504);
  expect(cleared.rank.calc).toContain('priority 1 × age 1 = 504');
  expect((await readRankBoard(w)).tasks.find((row) => row.id === made.id)?.rank).toStrictEqual(
    cleared.rank,
  );
});

it('no stage, internal Ops and an unconfigured journey keep neutral priority', async () => {
  const w = here();
  priorityApplied(await setPriority(w, ['trust'], (await readPriority(w)).revision));
  const made = await Promise.all([
    priorityTask(w, null),
    priorityTask(w, 'ops'),
    priorityTask(w, 'sales'),
  ]);
  const board = await readRankBoard(w);
  const ranked = await Promise.all(
    made.map(async (one) => ({ one, task: await readRankTask(w, one.id) })),
  );
  for (const { one, task } of ranked) {
    expect(task.rank.score).toBe(504);
    expect(task.rank.calc).toContain('priority 1 × age 1 = 504');
    expect(board.tasks.find((row) => row.id === one.id)?.rank).toStrictEqual(task.rank);
  }
});

it('configured priority composes with real age and rounds the 10.5 halfway score up', async () => {
  const w = here();
  priorityApplied(await setPriority(w, ['trust'], (await readPriority(w)).revision));
  const ordinary = await priorityTask(w, 'sales');
  const halfway = await priorityTask(w, 'trust', [1, 1, 8]);
  await dateRankTask(w, ordinary.id, 10);
  await dateRankTask(w, halfway.id, 10);
  const normalTask = await readRankTask(w, ordinary.id);
  const priority = await readRankTask(w, halfway.id);
  expect(normalTask.rank.score).toBe(529);
  expect(priority.rank.score).toBe(11);
  expect(priority.rank.calc).toContain('priority 1.25 × age 1.05 (1 week) = 11');
  const board = await readRankBoard(w);
  expect(board.tasks.find((row) => row.id === ordinary.id)?.rank).toStrictEqual(normalTask.rank);
  expect(board.tasks.find((row) => row.id === halfway.id)?.rank).toStrictEqual(priority.rank);
});

it('tenant configuration and record-only task authority preserve the visible rank pool', async () => {
  const w = here();
  priorityApplied(await setPriority(w, ['trust'], (await readPriority(w)).revision));
  priorityApplied(
    await setPriority(
      w,
      ['sales'],
      (await readPriority(w, w.otherOwner, w.foreign)).revision,
      w.otherOwner,
      w.foreign,
    ),
  );
  const localSales = await priorityTask(w, 'sales');
  const foreignSales = await priorityTask(w, 'sales', [7, 9, 8], w.otherOwner, w.foreign);
  expect((await readRankTask(w, localSales.id)).rank.score).toBe(504);
  expect((await readRankTask(w, foreignSales.id, w.otherOwner, w.foreign)).rank.score).toBe(630);
  const visible = await priorityTask(w, 'trust');
  const hidden = await priorityTask(w, 'trust', [10, 10, 10]);
  await w.db.app.withBusiness(w.business, (tx) =>
    grantTo(tx, w.reader, 'read', { kind: 'record', id: visible.id }),
  );
  expect(
    await executeRead(w.db.app, w.business, w.reader.presented, {
      read: 'settings.read',
    }),
  ).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
  const task = await readRankTask(w, visible.id, w.reader);
  expect(task.rank).toMatchObject({ score: 630, number: 1 });
  expect(task).not.toHaveProperty('settings');
  const board = await readRankBoard(w, w.reader);
  expect(board.tasks.map((row) => row.id)).toStrictEqual([visible.id]);
  expect(board.tasks[0]?.rank).toStrictEqual(task.rank);
  expect(board.tasks.some((row) => row.id === hidden.id || row.id === foreignSales.id)).toBe(false);
});
