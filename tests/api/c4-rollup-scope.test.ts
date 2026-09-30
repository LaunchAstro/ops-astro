// SPDX-License-Identifier: AGPL-3.0-only
//
// C4 (#429) `C4 rollup scope`, on a real database: the agency-wide rollups
// (CS-1.2, RA-20) are one team-only rollup read whose cache is keyed by
// business and viewer, so one viewer never receives another's rollup. The key
// also carries the viewer's live grants, so a grant narrowed, revoked or
// delegated inside the cache's lifetime is answered afresh. Built against a
// fixture rollup: the tasks the viewer may read.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  revokeGrant,
  TASK_TYPE_KEY,
  type BusinessId,
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';
import {
  createRollupCache,
  isCommandRefusal,
  readRollup,
  type CommandRefusal,
  type Rollup,
  type RollupCache,
} from '../../packages/core-commands/src/index.ts';
import { EFFECTIVE, issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { openSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { cq8World, type Party } from '../runtime/cq-8-world.ts';
import { subjects, tasksOf } from './c4-change-support.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) console.warn('api/c4-rollup-scope: DATABASE_URL is unset.');
let s: Schedules;
let alpha: Party;
let beta: Party;
let computed = 0;
let clock = 0;

/** The fixture rollup: every live task the viewer holds task:read on, by id. */
const readable: Rollup<string[]> = {
  name: 'fixture.readable-tasks',
  async compute(tx: TenantQuery, session) {
    computed += 1;
    const rows = await tx.query<{ id: string }>(
      `${EFFECTIVE},
         mine as (select e.scope_kind, e.scope_id from effective e
                   where e.collection = 'task' and e.action = 'read'
                     and ((e.subject_kind = 'person' and e.subject_id = $1)
                          or (e.subject_kind = 'actor' and e.subject_id = $2)))
       select r.id from public.records r
         join public.record_types t on t.business_id = r.business_id
          and t.id = r.record_type_id and t.key = $3
        where r.deleted_at is null
          and (exists (select 1 from mine where scope_kind = 'business')
               or r.id in (select scope_id from mine where scope_kind = 'record'))
        order by r.id`,
      [session.personId, session.actorId, TASK_TYPE_KEY],
    );
    return rows.map((row) => row.id);
  },
};

/** A rollup about the viewer alone, for two viewers who hold the same grants: none. */
const whoAmI: Rollup<string[]> = {
  name: 'fixture.who-am-i',
  compute: async (_tx, session) => await Promise.resolve([session.personId]),
};

const cacheOf = (lifetimeMs = 10_000, capacity = 100): RollupCache =>
  createRollupCache({ lifetimeMs, capacity, now: () => clock });

const rollupOf = async (
  cache: RollupCache,
  business: BusinessId,
  who: Member,
): Promise<string[] | CommandRefusal> =>
  await readRollup(s.db.app, business, who.presented, readable, cache);

const read = async (cache: RollupCache, business: BusinessId, who: Member): Promise<string[]> => {
  const got = await rollupOf(cache, business, who);
  if (isCommandRefusal(got)) throw new Error(`rollup refused ${got.code}`);
  return got;
};

const sorted = (values: readonly string[]): string[] => values.toSorted();

const member = async (business: BusinessId, recordId?: string): Promise<Member> => {
  const who = await enrol(s.db.app, business, `c4-roll-${randomUUID().slice(0, 8)}`);
  if (recordId !== undefined) {
    await s.db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, who, 'read', { kind: 'record', id: recordId }, true);
    });
  }
  return who;
};

/** C4 rollup scope: one viewer never receives another's rollup, across businesses and viewers */
async function keyedByBusinessAndViewer(): Promise<void> {
  const cache = cacheOf();
  const [a1, a2] = tasksOf(alpha);
  const [b1, b2] = tasksOf(beta);
  computed = 0;
  const wide = await read(cache, alpha.id, alpha.member);
  expect(wide).toEqual(expect.arrayContaining([a1, a2]));
  // A second viewer in the same business, holding one task: their own rollup.
  const narrow = await member(alpha.id, a1);
  expect(await read(cache, alpha.id, narrow)).toEqual([a1]);
  // Another business: its member reads its own and never alpha's; at alpha's key, refused.
  const betaRollup = await read(cache, beta.id, beta.member);
  expect(betaRollup).toEqual(expect.arrayContaining([b1, b2]));
  expect(betaRollup.some((id) => id === a1 || id === a2)).toBe(false);
  const across = await rollupOf(cache, alpha.id, beta.member);
  expect(isCommandRefusal(across) && across.code).toBe('AUTH_NO_MEMBERSHIP');
  expect(computed).toBe(3);
  // Within the lifetime each viewer's answer is reused, and only their own.
  expect(await read(cache, alpha.id, alpha.member)).toEqual(wide);
  expect(await read(cache, alpha.id, narrow)).toEqual([a1]);
  expect(computed).toBe(3);
  // Two viewers holding no grant at all share a fingerprint, and still each get their own.
  const [none1, none2] = [await member(alpha.id), await member(alpha.id)];
  for (const who of [none1, none2, none1]) {
    // eslint-disable-next-line no-await-in-loop -- in order, so the first is held.
    const got = await readRollup(s.db.app, alpha.id, who.presented, whoAmI, cache);
    expect(got).toEqual([who.personId]);
  }
  // One viewer's two rollups are held apart.
  const own = await readRollup(s.db.app, alpha.id, alpha.member.presented, whoAmI, cache);
  expect(own).toEqual([alpha.member.personId]);
  // Past the lifetime it is worked out again.
  clock += 10_001;
  expect(await read(cache, alpha.id, narrow)).toEqual([a1]);
  expect(computed).toBe(4);
}

/** C4 rollup scope: a grant narrowed, revoked or delegated inside the lifetime is answered afresh */
async function grantsInsideTheLifetime(): Promise<void> {
  const cache = cacheOf(60_000);
  const [a1, a2] = tasksOf(alpha);
  const viewer = await member(alpha.id, a1);
  const whole = await s.db.app.withBusiness(
    alpha.id,
    async (tx) => await grantTo(tx, viewer, 'read'),
  );
  expect(await read(cache, alpha.id, viewer)).toEqual(expect.arrayContaining([a1, a2]));
  await s.db.app.withBusiness(alpha.id, async (tx) => await revokeGrant(tx, whole));
  expect(await read(cache, alpha.id, viewer)).toEqual([a1]);

  // Another person under a live delegation: the delegated task while the parent lives.
  const holder = await member(alpha.id);
  const parent = await s.db.app.withBusiness(
    alpha.id,
    async (tx) => await grantTo(tx, holder, 'read', { kind: 'record', id: a2 }, true),
  );
  const delegate = await member(alpha.id);
  await s.db.app.withBusiness(alpha.id, async (tx) => {
    const issued = await issueGrant(tx, subjects(holder), {
      subject: { kind: 'person', id: delegate.personId },
      scope: { kind: 'record', id: a2 },
      collection: 'task',
      action: 'read',
      canDelegate: false,
      parentGrantId: parent,
      grantedByActorId: holder.actorId,
    });
    if (!issued.ok) throw new Error(`derived grant refused ${issued.refusal.code}`);
  });
  expect(await read(cache, alpha.id, delegate)).toEqual([a2]);
  await s.db.app.withBusiness(alpha.id, async (tx) => await revokeGrant(tx, parent));
  expect(await read(cache, alpha.id, delegate)).toEqual([]);
}

/** C4 rollup scope: team only; a client of the business reads no rollup and computes nothing */
async function teamOnly(): Promise<void> {
  const cache = cacheOf();
  await read(cache, alpha.id, alpha.member);
  computed = 0;
  for (const task of alpha.tasks) {
    // eslint-disable-next-line no-await-in-loop -- each client in turn.
    const got = await rollupOf(cache, alpha.id, task.client);
    expect(isCommandRefusal(got) && got.code).toBe('NOT_FOUND');
    expect(JSON.stringify(got)).not.toContain(task.id);
  }
  expect(computed).toBe(0);
}

/** C4 rollup scope: the cache holds no more answers than its capacity */
async function bounded(): Promise<void> {
  const cache = cacheOf(60_000, 2);
  const [a1, a2] = tasksOf(alpha);
  const viewers = [await member(alpha.id, a1), await member(alpha.id, a2), alpha.member];
  for (const viewer of viewers) {
    // eslint-disable-next-line no-await-in-loop -- in order, so the first is the oldest.
    await read(cache, alpha.id, viewer);
  }
  expect(cache.size).toBe(2);
  computed = 0;
  const [first] = viewers;
  if (first === undefined) throw new Error('viewer');
  expect(sorted(await read(cache, alpha.id, first))).toEqual([a1]);
  expect(computed).toBe(1);
  // An answer past its lifetime is let go when the next is held.
  clock += 60_001;
  await read(cache, alpha.id, alpha.member);
  expect(cache.size).toBe(1);
}

describe.skipIf(serverUrl === undefined)('C4 rollup scope, on a real database', () => {
  beforeAll(async () => {
    s = await openSchedules('c4ru', 1_000_000);
    const world = cq8World(s);
    alpha = await world.party(`c4r-${randomUUID().slice(0, 8)}`);
    beta = await world.party(`c4s-${randomUUID().slice(0, 8)}`);
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });
  it(
    "C4 rollup scope: the rollup cache is keyed by business and viewer, so one viewer never receives another's rollup",
    keyedByBusinessAndViewer,
  );
  it(
    'C4 rollup scope: a grant narrowed, revoked or delegated inside the lifetime is answered afresh',
    grantsInsideTheLifetime,
  );
  it('C4 rollup scope: team only; a client of the business reads no rollup', teamOnly);
  it('C4 rollup scope: the cache holds no more answers than its capacity', bounded);
});
