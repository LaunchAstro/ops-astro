// SPDX-License-Identifier: AGPL-3.0-only
//
// C4 live-sync 6, against a real database: the live channel adds no audit
// entry and no view record of its own.
//
// Every read is audited (I13), and that stands. The channel is not a read: its
// invalidation is emitted, never stored, and its checks return no content to
// the person, so they ask the grant model and audit nothing. Opening the stream
// is a request through the door like any other, so it records the login's one
// authentication attempt (I13's separate owner, which names no task), however
// many topics it names; each delivery's check and the per-topic recheck record
// nothing. The page re-read an invalidation causes is an ordinary read, and
// writes exactly I13's one event beside its own attempt.

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
import { PREFIX, pathOf } from '../../packages/core-wire/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { startLiveTopics, type LiveTopics } from '../../apps/api/live.ts';
import { authorised, post, tokenFor } from './fixture.ts';
import {
  count,
  join,
  liveApi,
  rowCounts,
  sleep,
  topic,
  within,
  type Joined,
} from './c4-live-support.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { createTask, openSchedules, type Schedules } from '../runtime/schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('api/c4-live-audit: DATABASE_URL is unset, so nothing below ran.');
}

let s: Schedules;
let key: string;
let pool: Database;
let listener: Listener;
let topics: LiveTopics;
let api: Hono;
const opened: Joined[] = [];

const changed = (before: Record<string, number>, after: Record<string, number>) =>
  Object.fromEntries(
    Object.keys({ ...before, ...after })
      .filter((name) => before[name] !== after[name])
      .map((name) => [name, (after[name] ?? 0) - (before[name] ?? 0)]),
  );

const touch = async (recordId: string): Promise<void> => {
  await pool.withBusiness(s.business, async (tx) => {
    await tx.query('update public.records set data = data where id = $1', [recordId]);
  });
};

/** The page's own re-read after an invalidation: one read event and its attempt, no other row. */
async function rereadWritesOneEvent(
  token: string,
  taskId: string,
  actorId: string,
  since: Record<string, number>,
): Promise<void> {
  const reread = await post(
    api,
    `${PREFIX.person}${key}${pathOf('task.read')}`,
    { read: 'task.read', recordId: taskId },
    authorised(token),
  );
  expect(reread.status).toBe(200);
  expect(changed(since, await rowCounts(s))).toEqual({
    'public.audit_events': 1,
    'public.authentication_attempts': 1,
  });
  const [event] = await s.db.admin.execute<Record<string, unknown>>(
    `select command, outcome, actor_id, subject_record_id from public.audit_events
      where business_id = $1 order by seq desc limit 1`,
    [s.business],
  );
  expect(event).toEqual({
    command: 'task.read',
    outcome: 'applied',
    actor_id: actorId,
    subject_record_id: taskId,
  });
}

/** C4 live-sync 6: the channel audits nothing and its rechecks write nothing; a page re-read writes I13's one event */
async function liveSync6(): Promise<void> {
  const taskId = await createTask(s, `c4a-quiet-${randomUUID()}`);
  const unreadable = await createTask(s, `c4a-unreadable-${randomUUID()}`);
  // Stamped once here, so the touch below changes no row count.
  await touch(taskId);
  const reader = await enrol(s.db.app, s.business, `c4a-reader-${randomUUID()}`);
  const grant = await s.db.app.withBusiness(
    s.business,
    async (tx) => await grantTo(tx, reader, 'read', { kind: 'record', id: taskId }),
  );
  const token = await tokenFor(reader.presented.subject);
  const before = await rowCounts(s);

  const tab = await join(api, key, [topic(taskId), topic(unreadable)], token);
  opened.push(tab);
  expect(tab.status).toBe(200);
  await within(2_000, () => count(tab, 'resync', topic(taskId)) === 1, 'joined');
  expect(count(tab, 'closed', topic(unreadable))).toBe(1);
  const door = await rowCounts(s);
  expect(changed(before, door)).toEqual({ 'public.authentication_attempts': 1 });
  await touch(taskId);
  await within(2_000, () => count(tab, 'invalidate', topic(taskId)) === 1, 'invalidated');
  // Five rechecks at 200 ms, each asking the grant model again.
  await sleep(1_000);
  expect(changed(door, await rowCounts(s))).toEqual({});

  await rereadWritesOneEvent(token, taskId, reader.actorId, door);

  // The recheck really runs: a revoked grant closes the topic with no write to wake it.
  await s.db.app.withBusiness(s.business, async (tx) => await revokeGrant(tx, grant));
  await within(2_000, () => tab.ended, 'the recheck closed the revoked topic');
  expect(count(tab, 'closed', topic(taskId))).toBe(1);
}

describe.skipIf(serverUrl === undefined)(
  'C4 live-sync 6 on a real database',
  { timeout: 30_000 },
  () => {
    beforeAll(async () => {
      s = await openSchedules('c4a', 1_000_000);
      const [row] = await s.db.admin.execute<{ key: string }>(
        'select key from public.businesses where id = $1',
        [s.business],
      );
      key = String(row?.key);
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
      'C4 live-sync 6: the live channel adds no audit entry and no view record of its own; its rechecks write nothing, and a page re-read writes exactly one read event',
      liveSync6,
    );
  },
);
