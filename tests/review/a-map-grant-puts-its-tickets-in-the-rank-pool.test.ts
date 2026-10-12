// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { readableRecordIds } from '../../packages/core-records/src/authority/readable-scope.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, must, wayfinderWorld, type WayfinderWorld } from '../wayfinder/world.ts';

const serverUrl = databaseUrlFromEnvironment();
const it = serverUrl === undefined ? vitestIt.skip : vitestIt;
let w: WayfinderWorld;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await wayfinderWorld('sol1364rank', 'sol1364rank');
}, 180_000);
afterAll(async () => await w?.drop());

it('the rank-pool helper includes tickets admitted through a map grant', async () => {
  const owner = await w.decider('Pool owner');
  const map = await w.create(owner, { title: 'Pool map' }, { taskType: 'map' });
  const ticket = await w.create(owner, { title: 'Pool ticket' }, { parentId: map.id });
  const nested = await w.create(
    owner,
    { title: 'Nested map' },
    { taskType: 'map', parentId: map.id },
  );
  const unrelated = await w.create(owner, { title: 'Unrelated task' });
  const reader = await w.member('Pool reader', ['read'], { kind: 'record', id: map.id });
  const detail = await executeRead(w.db.app, w.business, reader.presented, {
    read: 'task.read',
    recordId: ticket.id,
  });
  if (!('task' in detail)) throw new Error('ticket detail was refused');
  expect(detail.task.id).toBe(ticket.id);
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: nested.id }))).toBe(
    'SCOPE_NOT_GRANTED',
  );
  expect(codeOf(await w.read(reader, { read: 'task.read', recordId: unrelated.id }))).toBe(
    'SCOPE_NOT_GRANTED',
  );
  const ids = await w.db.app.withBusiness(w.business, async (tx) => {
    const [type] = await tx.query<{ readonly id: string }>(
      "select id from public.record_types where business_id = $1 and key = 'task'",
      [w.business],
    );
    if (type === undefined) throw new Error('task type missing');
    return await readableRecordIds(
      tx,
      [
        { kind: 'person', id: reader.personId },
        { kind: 'actor', id: reader.actorId },
      ],
      {
        collection: 'task',
        action: 'read',
        recordTypeId: type.id,
      },
    );
  });
  expect(ids.toSorted()).toEqual([map.id, ticket.id].toSorted());
});

it('a ticket rank includes the higher-scored sibling admitted through the same map', async () => {
  const owner = await w.decider('Rank owner');
  const map = await w.create(owner, { title: 'Rank map' }, { taskType: 'map' });
  const low = await w.create(owner, { title: 'Low ticket' }, { parentId: map.id });
  const high = await w.create(owner, { title: 'High ticket' }, { parentId: map.id });
  for (const [task, impact] of [
    [low, 1],
    [high, 10],
  ] as const) {
    must(
      // eslint-disable-next-line no-await-in-loop -- two scores, one after the other
      await w.as(owner, {
        command: 'task.set_scores',
        recordId: task.id,
        // eslint-disable-next-line no-await-in-loop -- each score's own revision
        expectedRevision: await w.revisionOf(task.id),
        fields: { impact, confidence: 10, ease: 10 },
      }),
      'score ticket',
    );
  }
  const reader = await w.member('Rank reader', ['read'], { kind: 'record', id: map.id });
  const higher = await executeRead(w.db.app, w.business, reader.presented, {
    read: 'task.read',
    recordId: high.id,
  });
  const lower = await executeRead(w.db.app, w.business, reader.presented, {
    read: 'task.read',
    recordId: low.id,
  });
  if (
    !('task' in higher) ||
    !('rank' in higher.task) ||
    !('task' in lower) ||
    !('rank' in lower.task)
  ) {
    throw new Error('ranked ticket detail was refused');
  }
  expect(higher.task.rank.score).toBe(1000);
  expect(lower.task.rank.score).toBe(100);
  expect(higher.task.rank.number).toBe(1);
  expect(lower.task.rank.number).toBe(2);
});
