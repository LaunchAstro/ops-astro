// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readTaskRank } from '../../packages/core-commands/src/reads/rank.ts';
import { readTaskFamily } from '../../packages/core-records/src/tasks/family.ts';
import { scopeCommand, scopeRead, scopeWorld, type ScopeWorld } from './typed-todo-scope-world.ts';
import { serverUrl } from '../acceptance/world.ts';

/** A database is needed: without one, the file skips. */
const LIVE = it.skipIf(serverUrl === undefined);

let w: ScopeWorld;
let taskTypeId: string;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await scopeWorld();
  const rows = await w.db.admin.execute<{ record_type_id: string; revision: string }>(
    'select record_type_id, revision::text from public.records where id = $1',
    [w.own],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('Expected the task fixture');
  taskTypeId = row.record_type_id;
  const scored = await scopeCommand(w, {
    command: 'task.set_scores',
    recordId: w.own,
    expectedRevision: Number(row.revision),
    fields: { impact: 7, confidence: 9, ease: 8 },
  });
  expect(scored).toMatchObject({ command: 'task.set_scores', recordId: w.own });
}, 180_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w?.db.drop();
});

LIVE('a record-scoped board accepts either UUID spelling', async () => {
  expect(w.teamA.toUpperCase()).not.toBe(w.teamA);
  const lower = await scopeRead(w, { read: 'task.board', board: w.teamA }, w.limited);
  expect(lower).toHaveProperty('tasks');
  const upper = await scopeRead(w, { read: 'task.board', board: w.teamA.toUpperCase() }, w.limited);
  expect(upper).toStrictEqual(lower);
});

LIVE('the direct rank helper identifies the same own row in either UUID spelling', async () => {
  const rank = (id: string) =>
    w.db.app.withBusiness(w.business, (tx) => readTaskRank(tx, taskTypeId, id, { kind: 'task' }));
  const lower = await rank(w.own);
  expect(lower).toMatchObject({ number: 1, score: 504 });
  expect(await rank(w.own.toUpperCase())).toStrictEqual(lower);
});

LIVE(
  'the direct family helper keeps the parent out of its child set in either UUID spelling',
  async () => {
    const family = (id: string) =>
      w.db.app.withBusiness(w.business, (tx) => readTaskFamily(tx, taskTypeId, id, []));
    const lower = await family(w.own);
    expect(lower.parent?.id).toBe(w.own);
    expect(lower.children).toStrictEqual([]);
    expect(await family(w.own.toUpperCase())).toStrictEqual(lower);
  },
);
