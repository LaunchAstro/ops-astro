// SPDX-License-Identifier: AGPL-3.0-only
//
// FIX-2B1 review RS2, proof: a tab that leaves while each real live route
// still awaits its door, through the composition root (`composeApi`), not a
// stand-in route.
//
// The request's signal is aborted as soon as the request is handed in, so the
// route's own door (`admit`, then `asks.atDoor` or `mayJoinBoard`) is in flight
// when the tab leaves, and the signal reads aborted by the time `streamSSE`
// runs its callback. Nothing reads or cancels the response body, so the only
// way the stream can end is app.ts's `endsWithRequest`.
//
// T2f's `follow` (app.ts) waits on `stream.onAbort` without first asking
// `stream.aborted`. `endsWithRequest` aborts the Hono stream synchronously
// before that `follow` adds its listener, and Hono never calls a listener added
// after `abort()`. So the T2f stream subscribes its topic, keeps its recheck
// timer, never ends, and `topics.close()` (shutdown) waits on it forever.
//
// The C4 task topic and the INB-1f board cases are expected green at the head:
// they also prove that app.ts itself calls `endsWithRequest` (remove the call
// and nothing ends them, because nothing else aborts their stream here).

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Listener } from '../../packages/core-records/src/index.ts';
import { PREFIX } from '../../packages/core-wire/src/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/index.ts';
import { composeApi } from '../../apps/api/server.ts';
import { startLiveTopics, type LiveTopics } from '../../apps/api/live.ts';
import { createLivePresence } from '../../apps/api/live-presence.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { testSignIn } from '../support/sign-in.ts';
import { authorised, ISSUER, tokenFor } from './fixture.ts';
import { createTask, openSchedules, type Schedules } from '../runtime/schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();
const BOUND_MS = 3_000;

/** Live topics on a listener that never hears a payload, counting what is subscribed now. */
async function countedTopics(): Promise<{
  readonly topics: LiveTopics;
  readonly now: { tasks: number; boards: number; ever: number };
}> {
  const listener = {
    listen: (_channel: string, _payload: unknown, onListening: () => void) => {
      onListening();
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  } as unknown as Listener;
  const real = await startLiveTopics(listener);
  const now = { tasks: 0, boards: 0, ever: 0 };
  const topics: LiveTopics = {
    subscribe(businessId, taskId, send, stop) {
      now.tasks += 1;
      now.ever += 1;
      const off = real.subscribe(businessId, taskId, send, stop);
      let on = true;
      return () => {
        if (on) now.tasks -= 1;
        on = false;
        off();
      };
    },
    subscribeBoard(businessId, personId, send, stop) {
      now.boards += 1;
      now.ever += 1;
      const off = real.subscribeBoard(businessId, personId, send, stop);
      let on = true;
      return () => {
        if (on) now.boards -= 1;
        on = false;
        off();
      };
    },
    get listening() {
      return real.listening;
    },
    close: async () => await real.close(),
  };
  return { topics, now };
}

async function bounded(running: Promise<unknown>): Promise<'resolved' | 'hung'> {
  return await Promise.race([
    running.then(() => 'resolved' as const),
    sleep(BOUND_MS, 'hung' as const),
  ]);
}

describe.skipIf(serverUrl === undefined)(
  'FIX-2B1 RS2: a tab that leaves at the door of each real live route',
  { timeout: 30_000 },
  // oxlint-disable-next-line max-lines-per-function -- one world, three routes
  () => {
    let s: Schedules;
    let key: string;
    let taskId: string;

    beforeAll(async () => {
      s = await openSchedules('fx2b1rs2', 1_000_000);
      const rows = await s.db.admin.execute<{ key: string }>(
        'select key from public.businesses where id = $1',
        [s.business],
      );
      key = String(rows[0]?.key);
      taskId = await createTask(s, `rs2-door-${randomUUID()}`);
    }, 180_000);

    afterAll(async () => {
      await s?.db.drop();
    });

    it.each([
      ['T2f /live/task/:id', (task: string) => `/live/task/${task}`],
      [
        'C4 /live?topic=task:<id>',
        (task: string) => `/live?topic=${encodeURIComponent(`task:${task}`)}`,
      ],
      ['INB-1f /live (the board)', () => '/live'],
    ] as const)(
      'FIX-2B1-RS2: %s, left while its door is awaited, ends, frees its topic and seat, and lets topics.close() resolve',
      async (_route, path) => {
        const { topics, now } = await countedTopics();
        const presence = createLivePresence();
        const api = composeApi({
          database: s.db.app,
          admin: s.db.admin,
          signIn: testSignIn(ISSUER),
          keys: runtimeKeys({ ...process.env }),
          live: { topics, presence, recheckMs: 60_000 },
        }).app;
        const token = await tokenFor(s.decider.presented.subject);
        const tab = new AbortController();
        const pending = api.fetch(
          new Request(`http://api.test${PREFIX.person}${key}${path(taskId)}`, {
            headers: authorised(token),
            signal: tab.signal,
          }),
        );
        // The tab leaves while the route's door is in flight, before any stream exists.
        tab.abort();
        const response = await pending;
        // Setup check: the door admitted the caller and the route built its stream.
        expect(response.status, 'the route answered with its stream').toBe(200);

        const started = Date.now();
        while (Date.now() - started < BOUND_MS && !(now.ever > 0 && now.tasks + now.boards === 0)) {
          // eslint-disable-next-line no-await-in-loop -- polling a bound
          await sleep(20);
        }
        try {
          expect.soft(now.ever, 'the route subscribed its stream').toBeGreaterThan(0);
          expect
            .soft(now, 'no topic is still subscribed for the tab that left')
            .toMatchObject({ tasks: 0, boards: 0 });
          expect
            .soft(presence.held, 'the presence book holds no seat for the tab that left')
            .toBe(0);
        } finally {
          expect
            .soft(await bounded(topics.close()), 'topics.close() (shutdown) resolves')
            .toBe('resolved');
        }
      },
      20_000,
    );
  },
);
