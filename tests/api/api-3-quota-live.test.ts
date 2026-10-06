// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each case reads top to bottom over one composed API */
//
// `API-3 quota` on the live channel (TR-SEC-4): a stream answers at once and
// runs on, so its caller's concurrent slot is held until the stream ends, not
// until it answers; and the presence routes, which resolve the caller as a
// stream's recheck does, are charged as every other admitted request is. Each
// case runs the real composed API, its real live admission and presence book,
// with small limits and a clock the test holds still.

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { Hono } from 'hono';
import {
  connect,
  connectListener,
  QUOTAS,
  type Database,
  type QuotaLimits,
} from '../../packages/core-records/src/index.ts';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/index.ts';
import { PREFIX } from '../../packages/core-wire/src/index.ts';
import { composeApi } from '../../apps/api/server.ts';
import { startLiveTopics, type LiveTopics } from '../../apps/api/live.ts';
import { createLivePresence, type LivePresence } from '../../apps/api/live-presence.ts';
import { testSignIn } from '../support/sign-in.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { createTask, openSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { authorised, ISSUER, tokenFor } from './fixture.ts';
import { join, sleep, topic, within, type Joined } from './c4-live-support.ts';

const serverUrl = databaseUrlFromEnvironment();

const seatOf = (tab: Joined): string =>
  tab.heard.find((frame) => frame.event === 'seat')?.data ?? '';

/** Held still: every request in a case falls in one window. */
const now = (): number => 1_000_000;

function quotaApi(
  s: Schedules,
  pool: Database,
  topics: LiveTopics,
  presence: LivePresence,
  limits: QuotaLimits,
): Hono {
  return composeApi({
    database: pool,
    admin: s.db.admin,
    signIn: testSignIn(ISSUER),
    keys: runtimeKeys({ ...process.env }),
    executeRead,
    live: { topics, recheckMs: 60_000, presence },
    quota: { limits, now },
  }).app;
}

async function keyOf(s: Schedules): Promise<string> {
  const [row] = await s.db.admin.execute<{ readonly key: string }>(
    'select key from public.businesses where id = $1',
    [s.business],
  );
  return row?.key ?? '';
}

async function expectQuotaRefusal(
  response: Response,
  dimension: string,
  holder: string,
): Promise<void> {
  expect(response.status).toBe(429);
  const body = (await response.json()) as Readonly<Record<string, unknown>>;
  expect(body['code']).toBe('QUOTA_EXCEEDED');
  expect(body['names']).toStrictEqual([dimension, holder]);
}

it.skipIf(serverUrl === undefined)(
  'API-3 quota: a live task stream holds its concurrent slot until the stream ends',
  async () => {
    const s = await openSchedules('api3qstream', 100_000);
    const pool = connect(s.db.appUrl, { max: 4 });
    const topics = await startLiveTopics(connectListener(s.db.appUrl));
    const limits = { ...QUOTAS, concurrent: { ...QUOTAS.concurrent, credential: 1 } };
    const api = quotaApi(s, pool, topics, createLivePresence(), limits);
    const open: Response[] = [];
    try {
      const taskId = await createTask(s, 'One stream at a time');
      const key = await keyOf(s);
      const token = await tokenFor(s.decider.presented.subject);
      const stream = async (): Promise<Response> => {
        const response = await api.fetch(
          new Request(`http://api.test${PREFIX.person}${key}/live/task/${taskId}`, {
            headers: authorised(token),
          }),
        );
        open.push(response);
        return response;
      };
      const first = await stream();
      expect(first.status).toBe(200);
      // The first stream is still open: its body is neither read to its end nor closed.
      await expectQuotaRefusal(await stream(), 'concurrent', 'credential');
      await first.body?.cancel();
      // Once the first stream has ended, its slot is back. The end reaches the
      // server a moment after the cancel, so a new stream is asked for until then.
      const admittedAgain = async (deadline: number): Promise<number> => {
        const again = await stream();
        if (again.status === 200 || Date.now() > deadline) return again.status;
        await sleep(25);
        return await admittedAgain(deadline);
      };
      expect(await admittedAgain(Date.now() + 2_000)).toBe(200);
    } finally {
      await Promise.allSettled(open.map(async (response) => await response.body?.cancel()));
      await topics.close();
      await pool.close();
      await s.db.drop();
    }
  },
);

it.skipIf(serverUrl === undefined)(
  'API-3 quota: the presence routes are charged as every request is, and a refused mark changes nothing',
  async () => {
    const s = await openSchedules('api3qpresence', 100_000);
    const pool = connect(s.db.appUrl, { max: 4 });
    const topics = await startLiveTopics(connectListener(s.db.appUrl));
    const presence = createLivePresence();
    const limits = { ...QUOTAS, requests: { ...QUOTAS.requests, credential: 1 } };
    const api = quotaApi(s, pool, topics, presence, limits);
    const opened: Joined[] = [];
    try {
      const taskId = await createTask(s, 'Marks within the quota');
      const observer = await enrol(s.db.app, s.business, `observer-${randomUUID()}`);
      await s.db.app.withBusiness(s.business, async (tx) => {
        await grantTo(tx, observer, 'read', { kind: 'record', id: taskId });
      });
      const key = await keyOf(s);
      const token = await tokenFor(s.decider.presented.subject);
      // Each caller's one request in the window is the stream it opens.
      const watching = await join(
        api,
        key,
        [topic(taskId)],
        await tokenFor(observer.presented.subject),
      );
      const marker = await join(api, key, [topic(taskId)], token);
      opened.push(watching, marker);
      expect([watching.status, marker.status]).toStrictEqual([200, 200]);
      await within(
        2_000,
        () => opened.every((tab) => tab.heard.some((frame) => frame.event === 'seat')),
        'both seats',
      );
      const seat = seatOf(marker);
      const marked = await api.request(`${PREFIX.person}${key}/live/mark`, {
        method: 'POST',
        headers: { ...authorised(token), 'content-type': 'application/json' },
        body: JSON.stringify({ seat, topic: topic(taskId), field: 'due' }),
      });
      await expectQuotaRefusal(marked, 'requests', 'credential');
      const seen = await api.request(
        `${PREFIX.person}${key}/live/presence?seat=${seat}&topic=${topic(taskId)}`,
        { headers: authorised(token) },
      );
      await expectQuotaRefusal(seen, 'requests', 'credential');
      const board = await api.request(`${PREFIX.person}${key}/task/board`, {
        method: 'POST',
        headers: { ...authorised(token), 'content-type': 'application/json' },
        body: JSON.stringify({ board: null }),
      });
      await expectQuotaRefusal(board, 'requests', 'credential');
      // The refused mark is nowhere in the book the observer reads.
      const book = presence.seenBy(s.business, taskId, seatOf(watching), observer.personId) ?? [];
      expect(book).not.toContainEqual(
        expect.objectContaining({ personId: s.decider.personId, state: 'changing' }),
      );
    } finally {
      await Promise.allSettled(opened.map(async (tab) => await tab.stop()));
      await topics.close();
      await pool.close();
      await s.db.drop();
    }
  },
);
