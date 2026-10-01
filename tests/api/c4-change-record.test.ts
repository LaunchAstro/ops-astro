// SPDX-License-Identifier: AGPL-3.0-only
//
// C4 (#429), the data layer (CS-15.19): the change record behind the live
// invalidations serves *changes since* for agents (API-4), on a real database.
// The point is a transaction watermark: a write open at the point is returned
// next time, never skipped; a duplicate near the point costs only a re-read.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  changesSince,
  revokeGrant,
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { openSchedules, racer, type Schedules } from '../runtime/schedules-harness.ts';
import { cq8World, type Party } from '../runtime/cq-8-world.ts';
import { changeKit, ids, subjects, tasksOf } from './c4-change-support.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) console.warn('api/c4-change-record: DATABASE_URL is unset.');
let s: Schedules;
let alpha: Party;
let beta: Party;
const { since, touch, pointAfter } = changeKit(() => s);

/** C4 changes since returns only the tasks changed after the point, and the next point */
async function afterThePoint(): Promise<void> {
  const [one, two] = tasksOf(alpha);
  await touch(alpha.id, [two]);
  const first = await since(alpha.id, alpha.member, null);
  expect([first.changes, first.point]).toEqual([[], expect.stringMatching(/^[1-9]\d*$/u)]);
  const point = await pointAfter(two);

  await touch(alpha.id, [one]);
  const equal = String(BigInt(await pointAfter(one)) - 1n);
  expect(ids(await since(alpha.id, alpha.member, equal))).toContain(one);
  const read = await since(alpha.id, alpha.member, point);
  expect(ids(read)).toContain(one);
  expect(ids(read)).not.toContain(two);
  expect(read.changes.every((change) => change.kind === 'task')).toBe(true);
  expect(BigInt(read.point)).toBeGreaterThanOrEqual(BigInt(point));

  await touch(alpha.id, [two]);
  expect(ids(await since(alpha.id, alpha.member, read.point))).toContain(two);
}

/** C4 changes since: a write still open when the point is taken is not lost */
async function openAtThePoint(): Promise<void> {
  const [one, two] = tasksOf(alpha);
  const other = racer(s);
  let wrote!: () => void;
  let release!: () => void;
  const written = new Promise<void>((resolve) => {
    wrote = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const open = other.withBusiness(alpha.id, async (tx) => {
    await tx.query('update public.records set data = data where id = $1', [one]);
    wrote();
    await released;
  });
  try {
    await written;
    // A later write that commits first, so the open one is not the newest.
    await touch(alpha.id, [two]);
    const { point } = await since(alpha.id, alpha.member, null);
    release();
    await open;
    expect(ids(await since(alpha.id, alpha.member, point))).toContain(one);
  } finally {
    release();
    await open.catch(() => {});
    await other.close();
  }
}

/** C4 changes since: a rolled-back write leaves no change */
async function rolledBack(): Promise<void> {
  const [, two] = tasksOf(alpha);
  await touch(alpha.id, [two]);
  const point = await pointAfter(two);
  await expect(
    s.db.app.withBusiness(alpha.id, async (tx) => {
      await tx.query('update public.records set data = data where id = $1', [two]);
      throw new Error('roll back');
    }),
  ).rejects.toThrow('roll back');
  expect(ids(await since(alpha.id, alpha.member, point))).not.toContain(two);
}

/** The read under a wrapper that records each statement it sends. */
async function counted(point: string | null) {
  const statements: string[] = [];
  const read = await s.db.app.withBusiness(alpha.id, async (tx) => {
    const query: TenantQuery['query'] = async (text, parameters) => {
      statements.push(text);
      return await tx.query(text, parameters);
    };
    return await changesSince({ businessId: tx.businessId, query }, subjects(alpha.member), point);
  });
  return { read, statements };
}

/** C4 changes since is one query on the change record */
async function oneQuery(): Promise<void> {
  const { statements } = await counted((await since(alpha.id, alpha.member, null)).point);
  expect(statements).toHaveLength(1);
  expect(statements[0]).toContain('public.live_changes');
}

const MALFORMED = [
  '',
  'abc',
  '-1',
  '01',
  '1.5',
  '1 ',
  ' 1',
  '1;select 1',
  '99999999999999999999',
  '１',
];

/** C4 changes since: a malformed point is refused before any query */
async function malformedPoint(): Promise<void> {
  const answers = await Promise.all(MALFORMED.map(async (point) => [point, await counted(point)]));
  const refused = { read: 'POINT_INVALID', statements: [] };
  expect(answers).toEqual(MALFORMED.map((point) => [point, refused]));
}

/** C4 isolation: changes since, across a business, a client and a person */
async function isolation(): Promise<void> {
  const [a1, a2] = tasksOf(alpha);
  const [b1, b2] = tasksOf(beta);
  const [alphaClient1, alphaClient2] = alpha.tasks.map((task) => task.client);
  if (alphaClient1 === undefined || alphaClient2 === undefined) throw new Error('clients');
  const alphaPoint = (await since(alpha.id, alpha.member, null)).point;
  const betaPoint = (await since(beta.id, beta.member, null)).point;
  await touch(alpha.id, [a1, a2]);
  await touch(beta.id, [b1, b2]);

  // Another business: each sees its own and never the other's.
  const alphaRead = ids(await since(alpha.id, alpha.member, alphaPoint));
  const betaRead = ids(await since(beta.id, beta.member, betaPoint));
  expect(alphaRead).toEqual(expect.arrayContaining([a1, a2]));
  expect(alphaRead).not.toEqual(expect.arrayContaining([b1]));
  expect(alphaRead.some((id) => id === b1 || id === b2)).toBe(false);
  expect(betaRead.some((id) => id === a1 || id === a2)).toBe(false);
  // Beta's member naming alpha's business reads nothing of alpha's.
  expect(ids(await since(alpha.id, beta.member, alphaPoint))).toEqual([]);

  // Another client in the same business: each client its own shared task.
  expect(ids(await since(alpha.id, alphaClient1, alphaPoint))).toEqual([a1]);
  expect(ids(await since(alpha.id, alphaClient2, alphaPoint))).toEqual([a2]);

  // Another person under a live delegated grant: a2 only while it lives.
  const other = await enrol(s.db.app, alpha.id, `c4-other-${randomUUID().slice(0, 8)}`);
  const derived = await s.db.app.withBusiness(alpha.id, async (tx) => {
    const parent = await grantTo(tx, alpha.member, 'read', { kind: 'record', id: a2 }, true);
    const issued = await issueGrant(tx, subjects(alpha.member), {
      subject: { kind: 'person', id: other.personId },
      scope: { kind: 'record', id: a2 },
      collection: 'task',
      action: 'read',
      canDelegate: false,
      parentGrantId: parent,
      grantedByActorId: alpha.member.actorId,
    });
    if (!issued.ok) throw new Error(`derived grant refused ${issued.refusal.code}`);
    return parent;
  });
  expect(ids(await since(alpha.id, other, alphaPoint))).toEqual([a2]);
  await s.db.app.withBusiness(alpha.id, async (tx) => await revokeGrant(tx, derived));
  expect(ids(await since(alpha.id, other, alphaPoint))).toEqual([]);
}

/** C4 changes since: two writers at once in opposite orders both land, with no deadlock */
async function twoWriters(): Promise<void> {
  const [a1, a2] = tasksOf(alpha);
  const { point } = await since(alpha.id, alpha.member, null);
  const one = racer(s);
  const two = racer(s);
  try {
    await Promise.all(
      Array.from({ length: 10 }, async (_, n) => {
        const db = n % 2 === 0 ? one : two;
        const order = n % 2 === 0 ? [a1, a2] : [a2, a1];
        await db.withBusiness(alpha.id, async (tx) => {
          await tx.query('update public.records set data = data where id = any($1::uuid[])', [
            order,
          ]);
        });
      }),
    );
  } finally {
    await one.close();
    await two.close();
  }
  expect(ids(await since(alpha.id, alpha.member, point))).toEqual(expect.arrayContaining([a1, a2]));
}

/** C4 changes since: the change record holds no content */
async function noContent(): Promise<void> {
  const columns = await s.db.admin.execute<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'live_changes' order by ordinal_position`,
  );
  expect(columns.map((column) => column.column_name)).toEqual([
    'business_id',
    'subject_kind',
    'subject_id',
    'changed_xid',
    'changed_at',
  ]);
}

describe.skipIf(serverUrl === undefined)(
  'C4 the live change record on a real database',
  { timeout: 30_000 },
  () => {
    beforeAll(async () => {
      s = await openSchedules('c4cr', 1_000_000);
      const world = cq8World(s);
      alpha = await world.party(`c4a-${randomUUID().slice(0, 8)}`);
      beta = await world.party(`c4b-${randomUUID().slice(0, 8)}`);
    }, 180_000);

    afterAll(async () => {
      await s?.db.drop();
    });
    it(
      'C4 changes since returns only the tasks changed after the point, and the next point',
      afterThePoint,
    );
    it('C4 changes since: a write still open when the point is taken is not lost', openAtThePoint);
    it('C4 changes since: a rolled-back write leaves no change', rolledBack);
    it('C4 changes since is one query on the change record', oneQuery);
    it('C4 changes since: a malformed point is refused before any query', malformedPoint);
    it('C4 isolation: changes since, across a business, a client and a person', isolation);
    it(
      'C4 changes since: two writers at once in opposite orders both land, with no deadlock',
      twoWriters,
    );
    it('C4 changes since: the change record holds no content', noContent);
  },
);
