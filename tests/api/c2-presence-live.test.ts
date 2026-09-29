// SPDX-License-Identifier: AGPL-3.0-only
//
// C2 (#471) through the real live stream (C4's one stream per tab), on a real
// database. A tab's stream is handed a seat; each task it watches seats it in
// the presence book, a change there is `presence` with the topic alone, and
// the tab re-reads who else is there. Marking the field being changed is a
// bounded route. Nothing is audited or stored; a client session neither sees
// staff presence nor is seen; presence follows the same checks as the stream.

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
import { PREFIX } from '../../packages/core-wire/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { startLiveTopics, type LiveTopics } from '../../apps/api/live.ts';
import { createLivePresence, type LivePresence } from '../../apps/api/live-presence.ts';
import { authorised, tokenFor } from './fixture.ts';
import {
  delegatedRead,
  join,
  liveApi,
  rowCounts,
  topic,
  within,
  type Joined,
} from './c4-live-support.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { createTask, openSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { cq8World } from '../runtime/cq-8-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) console.warn('api/c2-presence-live: DATABASE_URL is unset.');
let s: Schedules;
let key: string;
let pool: Database;
let listener: Listener;
let topics: LiveTopics;
let presence: LivePresence;
let api: Hono;
const opened: Joined[] = [];

const keyOf = async (business: string): Promise<string> => {
  const rows = await s.db.admin.execute<{ key: string }>(
    'select key from public.businesses where id = $1',
    [business],
  );
  return String(rows[0]?.key);
};

/** A teammate of the decider, holding task:read on the whole business. */
const teammate = async (): Promise<Member> => {
  const who = await enrol(s.db.app, s.business, `c2-mate-${randomUUID().slice(0, 8)}`);
  await s.db.app.withBusiness(s.business, async (tx) => await grantTo(tx, who, 'read'));
  return who;
};

const open = async (taskIds: readonly string[], who: Member, at = key): Promise<Joined> => {
  const token = await tokenFor(who.presented.subject);
  const joined = await join(api, at, taskIds.map(topic), token);
  opened.push(joined);
  return joined;
};

const seatOf = async (joined: Joined): Promise<string> => {
  await within(2_000, () => joined.heard.some((h) => h.event === 'seat'), 'seated');
  return String(joined.heard.find((h) => h.event === 'seat')?.data);
};

const presenceHeard = (joined: Joined, taskId: string): number =>
  joined.heard.filter((h) => h.event === 'presence' && h.data === topic(taskId)).length;

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const call = async (who: Member, path: string, init: RequestInit = {}, at = key) => {
  const response = await api.fetch(
    new Request(`http://api.test${PREFIX.person}${at}/live/${path}`, {
      ...init,
      headers: { ...authorised(await tokenFor(who.presented.subject)), ...init.headers },
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const seenBy = async (who: Member, seat: string, taskId: string, at = key): Promise<Answer> =>
  await call(who, `presence?seat=${seat}&topic=${topic(taskId)}`, {}, at);

const mark = async (who: Member, body: unknown, at = key): Promise<Answer> =>
  await call(
    who,
    'mark',
    { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
    at,
  );

const names = (answer: Answer): unknown =>
  (answer.body['seenBy'] as { personId: string; state: string; field: string | null }[]).map(
    ({ personId, state, field }) => ({ personId, state, field }),
  );

/** C2 presence shown (task): two teammates each see the other, and who is changing which field */
async function shownOnATask(): Promise<void> {
  const taskId = await createTask(s, `c2-${randomUUID()}`);
  const mate = await teammate();
  const mine = await open([taskId], s.decider);
  const theirs = await open([taskId], mate);
  const [mySeat, theirSeat] = [await seatOf(mine), await seatOf(theirs)];
  await within(2_000, () => presenceHeard(mine, taskId) >= 1, 'my tab heard them arrive');
  expect(names(await seenBy(s.decider, mySeat, taskId))).toEqual([
    { personId: mate.personId, state: 'viewing', field: null },
  ]);
  expect(names(await seenBy(mate, theirSeat, taskId))).toEqual([
    { personId: s.decider.personId, state: 'viewing', field: null },
  ]);
  const before = presenceHeard(theirs, taskId);
  expect((await mark(s.decider, { seat: mySeat, topic: topic(taskId), field: 'due' })).status).toBe(
    200,
  );
  await within(2_000, () => presenceHeard(theirs, taskId) > before, 'their tab heard the mark');
  expect(names(await seenBy(mate, theirSeat, taskId))).toEqual([
    { personId: s.decider.personId, state: 'changing', field: 'due' },
  ]);
  await mark(s.decider, { seat: mySeat, topic: topic(taskId), field: null });
  expect(names(await seenBy(mate, theirSeat, taskId))).toEqual([
    { personId: s.decider.personId, state: 'viewing', field: null },
  ]);
  // A leaving is at once: the tab closes and they are gone.
  const heard = presenceHeard(mine, taskId);
  await theirs.stop();
  await within(2_000, () => presenceHeard(mine, taskId) > heard, 'my tab heard them leave');
  expect(names(await seenBy(s.decider, mySeat, taskId))).toEqual([]);
  await mine.stop();
  await within(2_000, () => presence.held === 0, 'nothing held once everyone has gone');
}

/** C2 the mark route refuses unknown field names, other bodies and other people's seats */
async function boundedMark(): Promise<void> {
  const taskId = await createTask(s, `c2-mark-${randomUUID()}`);
  const other = await createTask(s, `c2-other-${randomUUID()}`);
  const mate = await teammate();
  const mine = await open([taskId], s.decider);
  const theirs = await open([taskId], mate);
  const [mySeat, theirSeat] = [await seatOf(mine), await seatOf(theirs)];
  const t = topic(taskId);
  const refusals: [unknown, number, string, string[]][] = [
    [{ seat: mySeat, topic: t, field: 'not_a_field' }, 422, 'FIELD_VALUE_INVALID', ['field']],
    [{ seat: mySeat, topic: t, field: 'due', note: 'x' }, 422, 'FIELD_UNKNOWN', ['note']],
    [{ seat: mySeat, topic: t }, 422, 'FIELD_VALUE_INVALID', ['field']],
    [{ seat: 'nope', topic: t, field: 'due' }, 422, 'FIELD_VALUE_INVALID', ['seat']],
    [{ seat: mySeat, topic: 'task:x', field: 'due' }, 422, 'FIELD_VALUE_INVALID', ['topic']],
    [{ seat: mySeat, topic: t, field: 'DUE' }, 422, 'FIELD_VALUE_INVALID', ['field']],
    [{ seat: mySeat, topic: t, field: ' due' }, 422, 'FIELD_VALUE_INVALID', ['field']],
    [['due'], 400, 'COMMAND_BODY_INVALID', []],
    // Another person's seat, and a seat not on that topic: no such seat.
    [{ seat: theirSeat, topic: t, field: 'due' }, 404, 'NOT_FOUND', []],
    [{ seat: mySeat, topic: topic(other), field: 'due' }, 404, 'NOT_FOUND', []],
  ];
  for (const [body, status, code, fields] of refusals) {
    // eslint-disable-next-line no-await-in-loop -- one refusal at a time.
    const answer = await mark(s.decider, body);
    expect([answer.status, answer.body['code'], answer.body['names'] ?? []]).toEqual([
      status,
      code,
      fields,
    ]);
  }
  expect(names(await seenBy(mate, theirSeat, taskId))).toEqual([
    { personId: s.decider.personId, state: 'viewing', field: null },
  ]);
  // Nor is another person's seat read through.
  const through = await seenBy(mate, mySeat, taskId);
  expect([through.status, through.body['code']]).toEqual([404, 'NOT_FOUND']);
  await Promise.all([mine.stop(), theirs.stop()]);
}

/** C2 presence reads, marks and events add no audit event and write no row */
async function noAudit(): Promise<void> {
  const taskId = await createTask(s, `c2-audit-${randomUUID()}`);
  const mate = await teammate();
  const mine = await open([taskId], s.decider);
  const theirs = await open([taskId], mate);
  const [mySeat, theirSeat] = [await seatOf(mine), await seatOf(theirs)];
  await within(2_000, () => presenceHeard(mine, taskId) >= 1, 'arrived');
  const before = await rowCounts(s);
  await mark(s.decider, { seat: mySeat, topic: topic(taskId), field: 'title' });
  await within(2_000, () => presenceHeard(theirs, taskId) >= 2, 'marked');
  await seenBy(mate, theirSeat, taskId);
  await mark(s.decider, { seat: mySeat, topic: topic(taskId), field: null });
  await seenBy(s.decider, mySeat, taskId);
  expect(await rowCounts(s)).toEqual(before);
  await Promise.all([mine.stop(), theirs.stop()]);
}

/** C2 isolation: presence across another business, another client and a person under a delegation */
async function isolation(): Promise<void> {
  const taskId = await createTask(s, `c2-iso-${randomUUID()}`);
  const mine = await open([taskId], s.decider);
  const mySeat = await seatOf(mine);
  const world = cq8World(s);
  // Another business: its member naming our task is refused at their key and at ours, never
  // seated; our seat's id, named from their key or ours, reads nothing of us.
  const other = await world.party(`c2-iso-${randomUUID().slice(0, 8)}`);
  const otherKey = await keyOf(other.id);
  expect((await open([taskId], other.member, otherKey)).status).not.toBe(200);
  expect((await open([taskId], other.member)).status).toBe(403);
  for (const at of [otherKey, key]) {
    // eslint-disable-next-line no-await-in-loop -- each key in turn.
    const read = await seenBy(other.member, mySeat, taskId, at);
    expect([read.status === 200, JSON.stringify(read.body).includes(s.decider.personId)]).toEqual([
      false,
      false,
    ]);
  }
  // Two clients of this business on this task: off the channel, never seen, seeing nothing.
  await s.db.app.withBusiness(s.business, async (tx) => await grantTo(tx, s.decider, 'share'));
  const client1 = await world.client(s.business, s.decider, 'c2-client-1', taskId);
  const client2 = await world.client(s.business, s.decider, 'c2-client-2', taskId);
  for (const client of [client1, client2]) {
    // eslint-disable-next-line no-await-in-loop -- each client in turn.
    expect((await open([taskId], client)).status).not.toBe(200);
    // eslint-disable-next-line no-await-in-loop -- each client in turn.
    const read = await seenBy(client, mySeat, taskId);
    expect([read.status, JSON.stringify(read.body).includes(s.decider.personId)]).toEqual([
      404,
      false,
    ]);
  }
  expect(names(await seenBy(s.decider, mySeat, taskId))).toEqual([]);
  // A person under a live delegation is seen while it lives, and gone once it is revoked.
  const delegate = await enrol(s.db.app, s.business, `c2-del-${randomUUID().slice(0, 8)}`);
  const parent = await s.db.app.withBusiness(
    s.business,
    async (tx) => await delegatedRead(tx, s.decider, delegate, taskId),
  );
  const theirs = await open([taskId], delegate);
  const theirSeat = await seatOf(theirs);
  expect(names(await seenBy(s.decider, mySeat, taskId))).toEqual([
    { personId: delegate.personId, state: 'viewing', field: null },
  ]);
  await s.db.app.withBusiness(s.business, async (tx) => await revokeGrant(tx, parent));
  expect((await seenBy(delegate, theirSeat, taskId)).status).not.toBe(200);
  await within(2_000, () => theirs.heard.some((h) => h.event === 'closed'), 'delegate closed');
  expect(names(await seenBy(s.decider, mySeat, taskId))).toEqual([]);
  await Promise.all([mine.stop(), theirs.stop()]);
}

describe.skipIf(serverUrl === undefined)('C2 presence on the live stream', () => {
  beforeAll(async () => {
    s = await openSchedules('c2p', 1_000_000);
    key = await keyOf(s.business);
    pool = connect(s.db.appUrl, { max: 4 });
    listener = connectListener(s.db.appUrl);
    topics = await startLiveTopics(listener);
    presence = createLivePresence();
    api = liveApi(s, pool, topics, () => {}, presence);
  }, 180_000);

  afterAll(async () => {
    await Promise.allSettled(opened.map(async (joined) => await joined.stop()));
    await topics?.close();
    await pool?.close();
    await s?.db.drop();
  });
  it(
    'C2 presence shown (task): two teammates each see the other, and who is changing which field',
    shownOnATask,
  );
  it('C2 the mark route refuses unknown field names, other bodies and other seats', boundedMark);
  it('C2 presence reads, marks and events add no audit event and write no row', noAudit);
  it(
    'C2 isolation: presence across another business, another client and a person under a delegation',
    isolation,
  );
});
