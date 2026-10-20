// SPDX-License-Identifier: AGPL-3.0-only
//
// A sign-in provider outage (its key set unreachable, the verifier's
// `unavailable`) is not an ended session. Through the real routes over a real
// database: a task's own stream, a tab's stream following a task topic and the
// board's stream each stay open through rechecks the provider cannot answer,
// say nothing meanwhile, and once the provider answers again a change made
// during the outage is told. It goes red if a stream reads `unavailable` as a
// session that ended and closes. The door itself answers 503 while the
// provider cannot be asked, as before.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier, type Verifier } from '../../apps/api/auth/supabase.ts';
import { startLiveTopics, type LiveTopics } from '../../apps/api/live.ts';
import { createBusinessResolver } from '../../apps/api/server.ts';
import { admitReads, executeCommand, executeRead } from '../../packages/core-commands/src/index.ts';
import { connect, connectListener, type Database } from '../../packages/core-records/src/index.ts';
import { PREFIX } from '../../packages/core-wire/src/index.ts';
import { createTask, openSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { testSignIn } from '../support/sign-in.ts';
import { authorised, ISSUER, tokenFor } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
const RECHECK_MS = 100;

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function within(ms: number, check: () => boolean, what: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error(`not within ${String(ms)} ms: ${what}`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(10);
  }
}

interface Opened {
  readonly status: number;
  readonly frames: { readonly event: string; readonly data: string }[];
  ended: boolean;
  stop(): Promise<void>;
}

/** Open a stream and record each frame as it arrives. */
async function open(api: Hono, path: string, token: string): Promise<Opened> {
  const response = await api.fetch(
    new Request(`http://api.test${path}`, { headers: authorised(token) }),
  );
  const frames: { event: string; data: string }[] = [];
  if (response.status !== 200 || response.body === null) {
    await response.text();
    return { status: response.status, frames, ended: true, stop: async () => {} };
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const opened: Opened = {
    status: 200,
    frames,
    ended: false,
    stop: async () => await reader.cancel().catch(() => {}),
  };
  void (async () => {
    let buffer = '';
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      for (let at = buffer.indexOf('\n\n'); at !== -1; at = buffer.indexOf('\n\n')) {
        const lines = buffer.slice(0, at).split('\n');
        const field = (name: string) =>
          lines
            .find((line) => line.startsWith(`${name}:`))
            ?.slice(name.length + 1)
            .trim() ?? '';
        frames.push({ event: field('event'), data: field('data') });
        buffer = buffer.slice(at + 2);
      }
    }
  })()
    .catch(() => {})
    .finally(() => {
      opened.ended = true;
    });
  return opened;
}

const events = (opened: Opened, name: string): number =>
  opened.frames.filter((frame) => frame.event === name).length;

let s: Schedules;
let key: string;
let pool: Database;
let topics: LiveTopics;
let api: Hono;
let token: string;
const outage = { on: false };
const streams: Opened[] = [];

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('liveoutage', 1_000_000);
  const [row] = await s.db.admin.execute<{ key: string }>(
    'select key from public.businesses where id = $1',
    [s.business],
  );
  key = String(row?.key);
  pool = connect(s.db.appUrl, { max: 4 });
  topics = await startLiveTopics(connectListener(s.db.appUrl));
  const real = createSupabaseVerifier(testSignIn(ISSUER));
  const verify: Verifier = async (request) =>
    outage.on ? await Promise.resolve('unavailable' as const) : await real(request);
  api = createApi({
    database: pool,
    verify,
    resolveBusiness: createBusinessResolver(s.db.admin),
    executeRead,
    executeCommand,
    live: { topics, recheckMs: RECHECK_MS, admit: admitReads },
  });
  token = await tokenFor(s.decider.presented.subject);
}, 180_000);

afterAll(async () => {
  await Promise.allSettled(streams.map(async (stream) => await stream.stop()));
  await topics?.close();
  await pool?.close();
  await s?.db.drop();
});

const touch = async (recordId: string): Promise<void> => {
  await pool.withBusiness(s.business, async (tx) => {
    await tx.query('update public.records set data = data where id = $1', [recordId]);
  });
};

async function opening(path: string): Promise<Opened> {
  const opened = await open(api, `${PREFIX.person}${key}${path}`, token);
  streams.push(opened);
  expect(opened.status).toBe(200);
  await within(2_000, () => events(opened, 'resync') >= 1, 'resync on connect');
  return opened;
}

/** `change` made while the provider cannot answer, over several rechecks: the stream stays open and says nothing. */
async function throughOutage(stream: Opened, change: () => Promise<void>): Promise<void> {
  const before = stream.frames.length;
  outage.on = true;
  try {
    await change();
    await sleep(RECHECK_MS * 6);
    expect(stream.ended, 'the stream ended during the outage').toBe(false);
    expect(stream.frames.slice(before)).toEqual([]);
  } finally {
    outage.on = false;
  }
}

const withDatabase = it.skipIf(serverUrl === undefined);

withDatabase.each([
  ["a task's own stream", (task: string) => `/live/task/${task}`],
  ['a tab stream following a task topic', (task: string) => `/live?topic=task:${task}`],
] as const)(
  '%s stays open and says nothing while the provider cannot answer, then tells the change',
  { timeout: 30_000 },
  async (_what, path) => {
    const taskId = await createTask(s, `live-outage-${randomUUID()}`);
    const stream = await opening(path(taskId));
    await throughOutage(stream, async () => await touch(taskId));
    await within(2_000, () => events(stream, 'invalidate') > 0, 'the change once answered');
    expect(events(stream, 'closed')).toBe(0);
    expect(stream.ended).toBe(false);
  },
);

withDatabase(
  "the board's stream stays open and says nothing while the provider cannot answer",
  { timeout: 30_000 },
  async () => {
    const stream = await opening('/live');
    await throughOutage(stream, async () => {
      await touch(await createTask(s, `live-outage-board-${randomUUID()}`));
    });
    await within(2_000, () => events(stream, 'resync') > 1, 'the change once answered');
    expect(events(stream, 'closed')).toBe(0);
    expect(stream.ended).toBe(false);
  },
);

withDatabase('the door answers 503 while the provider cannot be asked', async () => {
  const taskId = await createTask(s, `live-outage-door-${randomUUID()}`);
  outage.on = true;
  try {
    for (const path of [`/live/task/${taskId}`, `/live?topic=task:${taskId}`, '/live']) {
      // eslint-disable-next-line no-await-in-loop -- one door after another
      const opened = await open(api, `${PREFIX.person}${key}${path}`, token);
      expect(opened.status, path).toBe(503);
    }
  } finally {
    outage.on = false;
  }
});
