// SPDX-License-Identifier: AGPL-3.0-only
//
// C4 notifications live, against a real database: the board's stream (INB-1f)
// is one topic, `board`, on the tab's one C4 stream, so a tab holding the board,
// its inbox and a task page opens one connection. Every board frame is labelled
// `board` and names no task; the board is asked about as INB-1f asks it, and it
// closes alone, as a task topic does.

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
  liveApi,
  type Joined,
} from './c4-live-support.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  createTask,
  freshPurpose,
  openSchedules,
  propose,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { cq8World } from '../runtime/cq-8-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('api/c4-notifications-live: DATABASE_URL is unset, so nothing below ran.');
}

const BOARD = 'board';

let s: Schedules;
let key: string;
let pool: Database;
let listener: Listener;
let topics: LiveTopics;
let api: Hono;
const opened: Joined[] = [];

const keyOf = async (business: string): Promise<string> => {
  const rows = await s.db.admin.execute<{ key: string }>(
    'select key from public.businesses where id = $1',
    [business],
  );
  return String(rows[0]?.key);
};

const open = async (names: readonly string[], who: Member, at?: string): Promise<Joined> => {
  const joined = await join(api, at ?? key, names, await tokenFor(who.presented.subject));
  opened.push(joined);
  return joined;
};

const touch = async (business: string, recordId: string): Promise<void> => {
  await pool.withBusiness(business, async (tx) => {
    await tx.query('update public.records set data = data where id = $1', [recordId]);
  });
};

/** The board's frames so far: batch 1's board says only `resync` (and `closed`), naming no task. */
const moves = (joined: Joined): number => count(joined, 'resync', BOARD);

/** The board's count once it stops moving, so a recheck resync never stands in for a change. */
const still = async (joined: Joined): Promise<number> => {
  for (let heard = moves(joined); ; heard = moves(joined)) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(450);
    if (moves(joined) === heard) return heard;
  }
};

/**
 * A write on `forbidden` says nothing to `tab`. Then a write `tab` hears, on `own`, is its own
 * barrier: frames come in the order their signals came, so the one frame since is `own`'s.
 */
type Row = readonly [business: string, recordId: string];
const saysNothingOf = async (tab: Joined, forbidden: Row, own: Row): Promise<void> => {
  const before = await still(tab);
  await touch(...forbidden);
  expect(await still(tab), 'a frame for a write the tab cannot read').toBe(before);
  await touch(...own);
  await within(2_000, () => moves(tab) > before, 'the tab’s own write');
  expect(await still(tab), 'one frame, for the tab’s own write').toBe(before + 1);
};

async function oneConnection(): Promise<void> {
  const taskId = await createTask(s, `c4n-one-${randomUUID()}`);
  const reviewer = await enrol(s.db.app, s.business, `c4n-reviewer-${randomUUID()}`);
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const action of ['read', 'decide'] as const) {
      // eslint-disable-next-line no-await-in-loop
      await grantTo(tx, reviewer, action, { kind: 'record', id: taskId });
    }
  });
  const tab = await open([topic(taskId), BOARD], reviewer);
  expect(tab.status, JSON.stringify(tab.refusal)).toBe(200);
  await within(2_000, () => count(tab, 'resync', BOARD) === 1, 'the board resynced');
  expect(count(tab, 'resync', topic(taskId))).toBe(1);

  // The proposal raises the reviewer's decision item and changes the task: the
  // board resyncs on this one stream (it names no task) and the task topic hears it.
  const joined = await still(tab);
  await propose(s, taskId, { maximumMinor: 1_000, purpose: freshPurpose() });
  await within(2_000, () => count(tab, 'invalidate', topic(taskId)) > 0, 'the task topic');
  await within(2_000, () => moves(tab) > joined, 'the board');
  expect(tab.raw).not.toContain(`data: ${taskId}`);

  // An inbox item alone, no task changed: the board resyncs, and the task topic hears nothing.
  const quiet = await still(tab);
  const invalidated = count(tab, 'invalidate', topic(taskId));
  await s.db.admin.execute(
    `insert into public.inbox_items
       (business_id, id, recipient_person_id, subject_record_id, reason, fact_kind, fact_id)
     values ($1, $2, $3, $4, 'mention', 'record', $5)`,
    [s.business, randomUUID(), reviewer.personId, taskId, randomUUID()],
  );
  await within(2_000, () => moves(tab) > quiet, 'the board heard the inbox item');
  expect(count(tab, 'invalidate', topic(taskId))).toBe(invalidated);
  carriesOnly(tab, [topic(taskId), BOARD]);
}

async function closedAlone(): Promise<void> {
  const kept = await createTask(s, `c4n-kept-${randomUUID()}`);
  const lost = await createTask(s, `c4n-lost-${randomUUID()}`);
  const narrow = await enrol(s.db.app, s.business, `c4n-narrow-${randomUUID()}`);
  const grant = await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, narrow, 'read', { kind: 'record', id: kept });
    return await grantTo(tx, narrow, 'read', { kind: 'record', id: lost });
  });
  const tab = await open([topic(lost), BOARD], narrow);
  expect(tab.status, JSON.stringify(tab.refusal)).toBe(200);
  await within(2_000, () => count(tab, 'resync', BOARD) === 1, 'joined');

  await s.db.app.withBusiness(s.business, async (tx) => await revokeGrant(tx, grant));
  await touch(s.business, lost);
  await within(2_000, () => count(tab, 'closed', topic(lost)) === 1, 'the task topic closed');
  // The last task topic gone, the board stays on the stream and delivers.
  const before = await still(tab);
  await touch(s.business, kept);
  await within(2_000, () => moves(tab) > before, 'the board still delivers');
  expect(tab.ended).toBe(false);
  expect(count(tab, 'closed', BOARD)).toBe(0);
  carriesOnly(tab, [topic(lost), BOARD]);

  // Every task topic refused at join: the board alone still opens the stream.
  const late = await open([topic(lost), BOARD], narrow);
  expect(late.status, JSON.stringify(late.refusal)).toBe(200);
  await within(2_000, () => count(late, 'resync', BOARD) === 1, 'the board alone');
  expect(count(late, 'closed', topic(lost))).toBe(1);
}

async function isolation(): Promise<void> {
  const world = cq8World(s);
  const other = await world.party(`c4n-iso-${randomUUID().slice(0, 8)}`);
  const [otherTask] = other.tasks;
  if (otherTask === undefined) throw new Error('party: two tasks');
  const mine = await createTask(s, `c4n-iso-${randomUUID()}`);
  const sibling = await createTask(s, `c4n-iso-sibling-${randomUUID()}`);

  // Another business: refused at this key; at its own it hears only its own.
  const foreign = await open([BOARD], other.member);
  expect(foreign.status).not.toBe(200);
  expect(foreign.raw).not.toContain(mine);
  const theirs = await open([BOARD], other.member, await keyOf(other.id));
  expect(theirs.status, JSON.stringify(theirs.refusal)).toBe(200);
  await within(2_000, () => count(theirs, 'resync', BOARD) === 1, 'their board');
  // A write in this business moves this business's board and never theirs.
  const witness = await open([BOARD], s.decider);
  expect(witness.status, JSON.stringify(witness.refusal)).toBe(200);
  await within(2_000, () => count(witness, 'resync', BOARD) === 1, 'this board');
  const witnessJoined = await still(witness);
  await saysNothingOf(theirs, [s.business, mine], [other.id, otherTask.id]);
  expect(moves(witness), 'this board heard its own write').toBeGreaterThan(witnessJoined);
  const theirsJoined = await still(theirs);
  await touch(other.id, otherTask.id);
  await within(2_000, () => moves(theirs) > theirsJoined, 'their own task');

  // Two clients in this business, one shared task each: both stay off the channel.
  await s.db.app.withBusiness(s.business, async (tx) => await grantTo(tx, s.decider, 'share'));
  const first = await world.client(s.business, s.decider, 'c4n-client-1', mine);
  const second = await world.client(s.business, s.decider, 'c4n-client-2', sibling);
  for (const [who, names] of [
    [first, [BOARD]],
    [second, [topic(sibling), BOARD]],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop
    const refused = await open(names, who);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.refusal).toMatchObject({ refused: true });
    expect(refused.raw).not.toContain(mine);
  }

  await delegated(mine, sibling, witness, [theirs], otherTask.id);
}

/**
 * Another person under a live delegated grant on one task: the board says that
 * task and never the other, and nothing once the parent is revoked.
 */
async function delegated(
  mine: string,
  sibling: string,
  witness: Joined,
  others: readonly Joined[],
  otherTaskId: string,
): Promise<void> {
  const delegate = await enrol(s.db.app, s.business, `c4n-delegate-${randomUUID()}`);
  // The delegate's own task: the barrier their board says once the delegation is revoked.
  const own = await createTask(s, `c4n-delegate-own-${randomUUID()}`);
  const parent = await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, delegate, 'read', { kind: 'record', id: own });
    return await delegatedRead(tx, s.decider, delegate, sibling);
  });
  const tab = await open([BOARD], delegate);
  expect(tab.status, JSON.stringify(tab.refusal)).toBe(200);
  await within(2_000, () => count(tab, 'resync', BOARD) === 1, 'the delegate joined');
  await saysNothingOf(tab, [s.business, mine], [s.business, sibling]);
  await s.db.app.withBusiness(s.business, async (tx) => await revokeGrant(tx, parent));
  await still(tab);
  await saysNothingOf(tab, [s.business, sibling], [s.business, own]);
  for (const each of [witness, ...others, tab]) {
    carriesOnly(each, [BOARD]);
    expect(each.raw).not.toContain(mine);
    expect(each.raw).not.toContain(sibling);
    expect(each.raw).not.toContain(otherTaskId);
  }
}

async function hostile(): Promise<void> {
  const taskId = await createTask(s, `c4n-hostile-${randomUUID()}`);
  for (const names of [
    [BOARD, BOARD],
    ['Board'],
    [' board'],
    ['board:'],
    [`board:${taskId}`],
    [BOARD, ...Array.from({ length: 32 }, () => topic(randomUUID()))],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const refused = await open(names, s.decider);
    expect(refused.status, names.join(' ')).toBe(422);
    expect(refused.refusal).toMatchObject({ refused: true, code: 'FIELD_VALUE_INVALID' });
  }
}

describe.skipIf(serverUrl === undefined)(
  'C4 notifications live: the board on the tab’s one stream',
  { timeout: 30_000 },
  () => {
    beforeAll(async () => {
      s = await openSchedules('c4n', 1_000_000);
      key = await keyOf(s.business);
      pool = connect(s.db.appUrl, { max: 4 });
      listener = connectListener(s.db.appUrl);
      topics = await startLiveTopics(listener);
      api = liveApi(s, pool, topics, () => {});
    }, 180_000);

    afterAll(async () => {
      await Promise.allSettled(opened.map(async (joined) => await joined.stop()));
      await topics?.close();
      await pool?.close();
      await s?.db.drop();
    });

    it(
      'C4 notifications live: a new notification and a task change reach the board and the task on one connection',
      oneConnection,
    );
    it(
      'C4 notifications live: the last task topic closed leaves the board delivering on the stream',
      closedAlone,
    );
    it(
      'C4 notifications live isolation: the board topic across another business, another client and a person under a delegation',
      isolation,
    );
    it('C4 notifications live: a hostile board topic set is refused whole', hostile);
  },
);
