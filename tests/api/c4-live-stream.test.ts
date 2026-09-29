// SPDX-License-Identifier: AGPL-3.0-only
//
// C4, one event stream per tab, against a real database.
//
// T2f built the live channel for one task per stream; a browser caps a origin
// at about six connections, so a tab opens one stream naming every topic its
// pages follow. Each topic is asked about at join and again before every
// delivery, exactly as T2f asks about its one task; a topic the caller may not
// read is closed alone, and an ended session closes them all.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import {
  connect,
  connectListener,
  revokeGrant,
  type Database,
  type Listener,
} from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { startLiveTopics, type LiveTopics } from '../../apps/api/live.ts';
import { tokenFor } from './fixture.ts';
import {
  carriesOnly,
  count,
  delegatedRead,
  join,
  sleep,
  topic,
  within,
  hostileTopicSets,
  liveApi,
  type Joined,
} from './c4-live-support.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { createTask, openSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { cq8World } from '../runtime/cq-8-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('api/c4-live-stream: DATABASE_URL is unset, so nothing below ran.');
}

let s: Schedules;
let key: string;
let pool: Database;
let listener: Listener;
let topics: LiveTopics;
let api: Hono;
let reads = 0;
const opened: Joined[] = [];

const keyOf = async (business: string): Promise<string> => {
  const rows = await s.db.admin.execute<{ key: string }>(
    'select key from public.businesses where id = $1',
    [business],
  );
  return String(rows[0]?.key);
};

const open = async (names: readonly string[], who: Member, token?: string, at?: string) => {
  const joined = await join(
    api,
    at ?? key,
    names,
    token ?? (await tokenFor(who.presented.subject)),
  );
  opened.push(joined);
  return joined;
};

const touch = async (business: string, recordId: string): Promise<void> => {
  await pool.withBusiness(business, async (tx) => {
    await tx.query('update public.records set data = data where id = $1', [recordId]);
  });
};

/** C4 one stream per tab: one stream carries every topic it names, each resynced and invalidated on its own */
async function oneStreamPerTab(): Promise<void> {
  const [one, two] = [await createTask(s, 'c4s-one'), await createTask(s, 'c4s-two')];
  const named = [topic(one), topic(two)];
  const tab = await open(named, s.decider);
  expect(tab.status).toBe(200);
  await within(2_000, () => named.every((t) => count(tab, 'resync', t) === 1), 'resyncs');

  await touch(s.business, one);
  await within(2_000, () => count(tab, 'invalidate', topic(one)) > 0, 'the first topic');
  await sleep(200);
  expect(count(tab, 'invalidate', topic(two))).toBe(0);
  await touch(s.business, two);
  await within(2_000, () => count(tab, 'invalidate', topic(two)) > 0, 'the second topic');
  expect(tab.ended).toBe(false);
  carriesOnly(tab, named);
}

/** C4 live-sync 1: two browsers on one task each hear a change within 1 s at p95 */
async function liveSync1(): Promise<void> {
  const taskId = await createTask(s, `c4s-p95-${randomUUID()}`);
  const other = await enrol(s.db.app, s.business, `c4s-second-${randomUUID()}`);
  await s.db.app.withBusiness(s.business, async (tx) => await grantTo(tx, other, 'read'));
  const tabs = [await open([topic(taskId)], s.decider), await open([topic(taskId)], other)];
  await within(2_000, () => tabs.every((t) => count(t, 'resync', topic(taskId)) === 1), 'joined');
  const took: number[] = [];
  for (let n = 1; n <= 20; n += 1) {
    const started = Date.now();
    // eslint-disable-next-line no-await-in-loop
    await touch(s.business, taskId);
    // eslint-disable-next-line no-await-in-loop
    await within(
      2_000,
      () => tabs.every((t) => count(t, 'invalidate', topic(taskId)) >= n),
      `change ${String(n)}`,
    );
    took.push(Date.now() - started);
  }
  const p95 = took.toSorted((a, b) => a - b)[Math.ceil(took.length * 0.95) - 1] ?? Infinity;
  expect(p95).toBeLessThan(1_000);
}

/** C4 stream scope: fan-out follows the session’s business, never a topic the caller names, and an ended session closes every topic */
async function streamScope(): Promise<void> {
  const world = cq8World(s);
  const other = await world.party(`c4s-other-${randomUUID().slice(0, 8)}`);
  const theirs = other.tasks[0]?.id ?? '';
  const mine = await createTask(s, `c4s-scope-${randomUUID()}`);
  const named = [topic(mine), topic(theirs)];

  // The other business's member, at their own key, names this business's task too.
  const foreign = await open(named, other.member, undefined, await keyOf(other.id));
  expect(foreign.status).toBe(200);
  await within(2_000, () => count(foreign, 'resync', topic(theirs)) === 1, 'their resync');
  expect(count(foreign, 'closed', topic(mine))).toBe(1);
  expect(count(foreign, 'resync', topic(mine))).toBe(0);
  await Promise.all(Array.from({ length: 10 }, async () => await touch(s.business, mine)));
  await touch(other.id, theirs);
  await within(2_000, () => count(foreign, 'invalidate', topic(theirs)) > 0, 'their write');
  await sleep(200);
  expect(count(foreign, 'invalidate', topic(mine))).toBe(0);
  carriesOnly(foreign, named);

  // Their member at this business's key: refused at the door.
  const crossed = await open([topic(mine)], other.member);
  expect(crossed.status).toBe(403);
  expect(crossed.refusal).toMatchObject({ refused: true, code: 'AUTH_NO_MEMBERSHIP' });

  // A session that expires closes every topic, then the stream.
  const brief = await open(
    [topic(mine), topic(await createTask(s, 'c4s-brief'))],
    s.decider,
    await tokenFor(s.decider.presented.subject, { expiresIn: 1 }),
  );
  expect(brief.status).toBe(200);
  await within(4_000, () => brief.ended, 'the expired session closed');
  expect(brief.heard.filter((h) => h.event === 'closed')).toHaveLength(2);
  expect(brief.heard.at(-1)?.event).toBe('closed');
}

/** C4 stream scope, hostile topics: a malformed topic set is refused whole, before any read */
async function hostileTopics(): Promise<void> {
  const real = topic(await createTask(s, 'c4s-hostile'));
  const hostile = hostileTopicSets(real);
  const token = await tokenFor(s.decider.presented.subject);
  for (const names of hostile) {
    const before = reads;
    // eslint-disable-next-line no-await-in-loop
    const refused = await open(names, s.decider, token);
    expect([names, refused.status]).toEqual([names, 422]);
    expect(refused.refusal).toMatchObject({ code: 'FIELD_VALUE_INVALID', names: ['topic'] });
    expect(reads).toBe(before);
  }
}

/** C4 revoked: a revoked topic is closed alone, the rest keep delivering, and nothing names more than the caller sent */
async function revoked(): Promise<void> {
  const [one, two] = [await createTask(s, 'c4s-rev-1'), await createTask(s, 'c4s-rev-2')];
  const narrow = await enrol(s.db.app, s.business, `c4s-narrow-${randomUUID()}`);
  const [grantOne] = await s.db.app.withBusiness(s.business, async (tx) => [
    await grantTo(tx, narrow, 'read', { kind: 'record', id: one }),
    await grantTo(tx, narrow, 'read', { kind: 'record', id: two }),
  ]);
  const named = [topic(one), topic(two)];
  const tab = await open(named, narrow);
  expect(tab.status).toBe(200);
  await within(2_000, () => named.every((t) => count(tab, 'resync', t) === 1), 'resyncs');

  await s.db.admin.execute(
    'update public.grants set revoked_at = now() where business_id = $1 and id = $2',
    [s.business, grantOne],
  );
  await touch(s.business, one);
  await within(2_000, () => count(tab, 'closed', topic(one)) === 1, 'the revoked topic');
  expect(count(tab, 'invalidate', topic(one))).toBe(0);
  await touch(s.business, one);
  await touch(s.business, two);
  await within(2_000, () => count(tab, 'invalidate', topic(two)) > 0, 'the other topic');
  await sleep(200);
  expect(count(tab, 'invalidate', topic(one))).toBe(0);
  expect(count(tab, 'closed', topic(one))).toBe(1);
  expect(tab.ended).toBe(false);
  carriesOnly(tab, named);

  const again = await open([topic(one)], narrow);
  expect(again.status).toBe(403);
  expect(again.refusal).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
  expect(JSON.stringify(again.refusal)).not.toContain(one);
}

/** C4 isolation: one stream across another business, another client and a person under a delegation */
async function isolation(): Promise<void> {
  const world = cq8World(s);
  const other = await world.party(`c4s-iso-${randomUUID().slice(0, 8)}`);
  const mine = await createTask(s, `c4s-iso-${randomUUID()}`);
  const sibling = await createTask(s, `c4s-iso-sibling-${randomUUID()}`);

  // Another business: at its own key it may not follow this task at all.
  const foreign = await open([topic(mine)], other.member, undefined, await keyOf(other.id));
  expect(foreign.status).toBe(404);
  expect(foreign.refusal).toMatchObject({ refused: true, code: 'NOT_FOUND' });

  // Two clients in this business, one shared task each: both stay off the channel.
  await s.db.app.withBusiness(s.business, async (tx) => await grantTo(tx, s.decider, 'share'));
  const first = await world.client(s.business, s.decider, 'c4s-client-1', mine);
  const second = await world.client(s.business, s.decider, 'c4s-client-2', sibling);
  for (const [who, names] of [
    [first, [topic(mine)]],
    [first, [topic(sibling)]],
    [second, [topic(mine), topic(sibling)]],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop
    const refused = await open(names, who);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.refusal).toMatchObject({ refused: true });
  }

  // Another person under a live delegated grant: the one task, while it lives.
  const delegate = await enrol(s.db.app, s.business, `c4s-delegate-${randomUUID()}`);
  const parent = await s.db.app.withBusiness(
    s.business,
    async (tx) => await delegatedRead(tx, s.decider, delegate, sibling),
  );
  const named = [topic(sibling), topic(mine)];
  const delegated = await open(named, delegate);
  expect(delegated.status).toBe(200);
  await within(2_000, () => count(delegated, 'resync', topic(sibling)) === 1, 'resync');
  expect(count(delegated, 'closed', topic(mine))).toBe(1);
  await s.db.app.withBusiness(s.business, async (tx) => await revokeGrant(tx, parent));
  await touch(s.business, sibling);
  await within(2_000, () => delegated.ended, 'the delegation ended, the stream closed');
  expect(count(delegated, 'closed', topic(sibling))).toBe(1);
  expect(delegated.heard.filter((h) => h.event === 'invalidate')).toEqual([]);
  carriesOnly(delegated, named);
}

describe.skipIf(serverUrl === undefined)(
  'C4 one event stream per tab on a real database',
  { timeout: 30_000 },
  () => {
    beforeAll(async () => {
      s = await openSchedules('c4s', 1_000_000);
      key = await keyOf(s.business);
      pool = connect(s.db.appUrl, { max: 4 });
      listener = connectListener(s.db.appUrl);
      topics = await startLiveTopics(listener);
      api = liveApi(s, pool, topics, () => (reads += 1));
    }, 180_000);

    afterAll(async () => {
      await Promise.allSettled(opened.map(async (joined) => await joined.stop()));
      await topics?.close();
      await pool?.close();
      await s?.db.drop();
    });

    it(
      'C4 one stream per tab: one stream carries every topic it names, each resynced and invalidated on its own',
      oneStreamPerTab,
    );
    it('C4 live-sync 1: two browsers on one task each hear a change within 1 s at p95', liveSync1);
    it(
      'C4 stream scope: fan-out follows the session’s business, never a topic the caller names, and an ended session closes every topic',
      streamScope,
    );
    it(
      'C4 stream scope, hostile topics: a malformed topic set is refused whole, before any read',
      hostileTopics,
    );
    it(
      'C4 revoked: a revoked topic is closed alone, the rest keep delivering, and nothing names more than the caller sent',
      revoked,
    );
    it(
      'C4 isolation: one stream across another business, another client and a person under a delegation',
      isolation,
    );
  },
);
