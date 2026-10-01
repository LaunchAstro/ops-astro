// SPDX-License-Identifier: AGPL-3.0-only
//
// C4 (#429) *changes since* answers exactly what `task.read` would let its
// caller read, on a real database. A grant on a map covers the map and its
// tickets (W12), as the commands and the reads honour it; a map is a task of
// type `map` and its tickets are its children (WF-1's facts, set by hand here).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revokeGrant, type BusinessId } from '../../packages/core-records/src/index.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { openSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { cq8World, type Party } from '../runtime/cq-8-world.ts';
import { changeKit, ids, subjects, tasksOf } from './c4-change-support.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) console.warn('api/c4-changes-map: DATABASE_URL is unset.');
let s: Schedules;
let alpha: Party;
let beta: Party;
const { since, touch, pointAfter } = changeKit(() => s);

/** A task filed by alpha's member, then typed and parented by hand. */
const filed = async (type: string, parentId: string | null): Promise<string> => {
  const made = await cq8World(s).command(alpha.id, alpha.member, {
    command: 'task.create',
    fields: { title: `c4-${type}-${randomUUID()}` },
  });
  if (isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
  const id = String(made.recordId);
  await s.db.admin.execute(
    `update public.records
        set data = data || jsonb_strip_nulls(jsonb_build_object('type', $2::text, 'parent', $3::text))
      where id = $1`,
    [id, type, parentId],
  );
  return id;
};

/** A new person in `business` holding a delegable task:read on one record, and that grant. */
const readerOf = async (
  business: BusinessId,
  recordId: string,
): Promise<{ reader: Member; grant: string }> => {
  const reader = await enrol(s.db.app, business, `c4-map-${randomUUID().slice(0, 8)}`);
  const grant = await s.db.app.withBusiness(
    business,
    async (tx) => await grantTo(tx, reader, 'read', { kind: 'record', id: recordId }, true),
  );
  return { reader, grant };
};

const readBy = async (business: BusinessId, recordId: string, point: string) =>
  ids(await since(alpha.id, (await readerOf(business, recordId)).reader, point)).toSorted();

/** A person under a live delegation of `grant`, on the same record. */
const delegateOf = async (from: Member, grant: string, recordId: string): Promise<Member> => {
  const delegate = await enrol(s.db.app, alpha.id, `c4-del-${randomUUID().slice(0, 8)}`);
  await s.db.app.withBusiness(alpha.id, async (tx) => {
    const issued = await issueGrant(tx, subjects(from), {
      subject: { kind: 'person', id: delegate.personId },
      scope: { kind: 'record', id: recordId },
      collection: 'task',
      action: 'read',
      canDelegate: false,
      parentGrantId: grant,
      grantedByActorId: from.actorId,
    });
    if (!issued.ok) throw new Error(`derived grant refused ${issued.refusal.code}`);
  });
  return delegate;
};

/**
 * C4 changes since answers exactly what task.read would: a grant on a map
 * covers the map and its tickets (W12), and nothing else
 */
async function mapScoped(): Promise<void> {
  const map = await filed('map', null);
  const ticket = await filed('build', map);
  const otherMap = await filed('map', null);
  const otherTicket = await filed('research', otherMap);
  const plain = await filed('task', null);
  const underPlain = await filed('task', plain);
  const mapInMap = await filed('map', map);
  const point = await pointAfter(mapInMap);
  await touch(alpha.id, [map, ticket, otherMap, otherTicket, plain, underPlain, mapInMap]);

  // The map's reader sees the map and its tickets, not a map filed under it; a reader of
  // another map, only that one's.
  const mapGrant = await readerOf(alpha.id, map);
  expect(ids(await since(alpha.id, mapGrant.reader, point)).toSorted()).toEqual(
    [map, ticket].toSorted(),
  );
  expect(await readBy(alpha.id, otherMap, point)).toEqual([otherMap, otherTicket].toSorted());
  // A grant on a ticket is the ticket's alone; on a task that is no map, its own and no child's.
  expect(await readBy(alpha.id, ticket, point)).toEqual([ticket]);
  expect(await readBy(alpha.id, plain, point)).toEqual([plain]);

  // Another client in the same business, and another business's reader: none of it.
  const [alphaClient] = alpha.tasks.map((task) => task.client);
  if (alphaClient === undefined) throw new Error('client');
  expect(ids(await since(alpha.id, alphaClient, point))).toEqual([]);
  expect(ids(await since(alpha.id, beta.member, point))).toEqual([]);
  const [betaTask] = tasksOf(beta);
  expect(await readBy(beta.id, betaTask, point)).toEqual([]);

  // Another person under a live delegation of the map grant: the map's changes while it lives.
  const delegate = await delegateOf(mapGrant.reader, mapGrant.grant, map);
  expect(ids(await since(alpha.id, delegate, point)).toSorted()).toEqual([map, ticket].toSorted());
  await s.db.app.withBusiness(alpha.id, async (tx) => await revokeGrant(tx, mapGrant.grant));
  expect(ids(await since(alpha.id, delegate, point))).toEqual([]);
}

describe.skipIf(serverUrl === undefined)(
  'C4 changes since on a map-scoped grant, on a real database',
  { timeout: 30_000 },
  () => {
    beforeAll(async () => {
      s = await openSchedules('c4cm', 1_000_000);
      const world = cq8World(s);
      alpha = await world.party(`c4m-${randomUUID().slice(0, 8)}`);
      beta = await world.party(`c4n-${randomUUID().slice(0, 8)}`);
    }, 180_000);

    afterAll(async () => {
      await s?.db.drop();
    });
    it(
      'C4 changes since answers exactly what task.read would: a grant on a map covers the map and its tickets, and nothing else',
      mapScoped,
    );
  },
);
