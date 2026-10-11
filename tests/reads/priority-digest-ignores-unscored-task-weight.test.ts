// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { boardReach, joinLiveBoard } from '../../packages/core-commands/src/reads/live-join.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import {
  priorityApplied,
  priorityTask,
  priorityWorld,
  readPriority,
  setPriority,
} from '../commands/priority-stages-support.ts';
import { readRankBoard, readRankTask, type RankCoreWorld } from './task-rank-core-world.ts';

let world: RankCoreWorld | undefined;
beforeAll(async () => {
  world = await priorityWorld();
}, 180_000);
afterAll(async () => {
  await world?.db.drop();
});

it('an unscored task reader hears no priority write that changes none of their visible ranks', async () => {
  const w = world;
  if (w === undefined) throw new Error('No proof database');
  const initial = await readPriority(w);
  priorityApplied(await setPriority(w, [], initial.revision));
  const task = await priorityTask(w, 'trust', [null, 9, 8]);
  const reader = await enrol(w.db.app, w.business, 'sol-unscored-task-only');
  await w.db.app.withBusiness(w.business, (tx) =>
    grantTo(tx, reader, 'read', { kind: 'record', id: task.id }),
  );
  const settings = await executeRead(w.db.app, w.business, reader.presented, {
    read: 'settings.read',
  });
  expect(isCommandRefusal(settings) && settings.code).toBe('SCOPE_NOT_GRANTED');
  expect(await joinLiveBoard(w.db.app, w.business, reader.presented)).toEqual({
    personId: reader.personId,
  });
  const before = await readRankTask(w, task.id, reader);
  const boardBefore = await readRankBoard(w, reader);
  expect(before.rank).toEqual({ number: null, score: null, calc: 'not ranked: missing impact' });
  const digest = await boardReach(w.db.app, w.business, reader.presented, reader.personId);
  expect(digest).toBeTypeOf('string');
  const current = await readPriority(w);
  priorityApplied(await setPriority(w, ['trust'], current.revision));
  expect(await readRankTask(w, task.id, reader)).toEqual(before);
  expect(await readRankBoard(w, reader)).toEqual(boardBefore);
  expect(await boardReach(w.db.app, w.business, reader.presented, reader.personId)).toBe(digest);
});
