// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1f: closing the live topics stops every live stream, a board's or a
// task's, and resolves only once no question one asked is still in flight.
// The pool closes after it, so a recheck that was running can never send its
// next statement down a connection that has already ended.

import type { SSEStreamingApi } from 'hono/streaming';
import { setTimeout } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import type { Listener } from '../../packages/core-records/src/index.ts';
import { follow } from '../../apps/api/app.ts';
import { followBoard } from '../../apps/api/live-board.ts';
import { startLiveTopics, type LiveTopics } from '../../apps/api/live.ts';

const noop = (): void => {};

/** A stream that records nothing and can be aborted, as the tab leaving does. */
function abortable(): SSEStreamingApi {
  let aborted = false;
  const onAbort: (() => void)[] = [];
  return {
    get aborted() {
      return aborted;
    },
    onAbort(callback: () => void) {
      onAbort.push(callback);
    },
    writeSSE: () => Promise.resolve(),
    abort() {
      aborted = true;
      for (const callback of onAbort) callback();
    },
  } as unknown as SSEStreamingApi;
}

const business = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const person = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const task = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const reach = (): Promise<string> => Promise.resolve('tasks');
const shown = (): Promise<string> => Promise.resolve('inbox');

/** Each stream, started with `ask` as the question its recheck asks. */
const streams: [
  string,
  (t: LiveTopics, s: SSEStreamingApi, ask: () => Promise<void>) => Promise<void>,
][] = [
  [
    'board',
    async (topics, stream, ask) => {
      const joinedAs = async (): Promise<string> => {
        await ask();
        return person;
      };
      const on = { businessId: business, personId: person, recheckMs: 5 };
      await followBoard(stream, topics, on, { joinedAs, reach, shown });
    },
  ],
  [
    'task',
    async (topics, stream, ask) => {
      const may = async (): Promise<string> => {
        await ask();
        return task;
      };
      await follow(stream, { topics, recheckMs: 5 }, business, task, may);
    },
  ],
];

// eslint-disable-next-line max-lines-per-function -- both stop orders for both stream kinds
describe('INB-1 live stream stop', () => {
  it.each(streams)(
    'closing the topics stops a %s stream, waits for its question in flight, and asks nothing after',
    async (_name, start) => {
      const listener = {
        listen: (_channel: string, _payload: unknown, onListening: () => void) => {
          onListening();
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      } as unknown as Listener;
      const topics = await startLiveTopics(listener);
      const stream = abortable();
      let asked = 0;
      let finish = noop;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      // The recheck's question is held open: a query in flight when close is called.
      const running = start(topics, stream, async () => {
        asked += 1;
        await held;
      });
      await vi.waitFor(() => expect(asked).toBe(1));

      const closing = topics.close();
      const first = await Promise.race([closing.then(() => 'closed'), setTimeout(50, 'waiting')]);
      expect(stream.aborted, 'close ends the stream').toBe(true);
      expect(first, 'close waits for the question in flight').toBe('waiting');

      finish();
      await closing;
      await running;
      const atClose = asked;
      await setTimeout(50);
      expect(asked, 'nothing is asked once close has resolved').toBe(atClose);
    },
  );

  it.each(streams)(
    'a late %s stream is stopped before topic closure ends',
    async (_name, start) => {
      const listener = {
        listen: (_channel: string, _payload: unknown, onListening: () => void) => {
          onListening();
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      } as unknown as Listener;
      const topics = await startLiveTopics(listener);
      const first = abortable();
      let asked = 0;
      let finish = noop;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const firstRunning = start(topics, first, async () => {
        asked += 1;
        await held;
      });
      await vi.waitFor(() => expect(asked).toBe(1));

      const closing = topics.close();
      await vi.waitFor(() => expect(first.aborted).toBe(true));
      // The HTTP listener can still admit this stream while close waits for the first.
      const late = abortable();
      const lateRunning = start(topics, late, () => Promise.resolve());
      finish();
      await closing;
      await firstRunning;
      const stoppedAtClose = late.aborted;
      late.abort();
      await lateRunning;
      expect(stoppedAtClose).toBe(true);
    },
  );

  it('a stream admitted once closing is stopped at once, asks nothing, and close waits for it', async () => {
    const topics = await startLiveTopics({
      listen: (_channel: string, _payload: unknown, onListening: () => void) => {
        onListening();
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    } as unknown as Listener);
    let release = noop;
    const letGo = new Promise<void>((resolve) => {
      release = resolve;
    });
    let unsubscribe = noop;
    const closing = topics.close();
    // A subscriber still letting go when it is stopped: close resolves only after.
    unsubscribe = topics.subscribe(business, task, noop, async () => {
      await letGo;
      unsubscribe();
    });
    const first = await Promise.race([closing.then(() => 'closed'), setTimeout(20, 'waiting')]);
    release();
    await closing;
    expect(first, 'close waits for a late stop').toBe('waiting');

    let asked = 0;
    const count =
      <T>(answer: T) =>
      async (): Promise<T> => {
        asked += 1;
        return await Promise.resolve(answer);
      };
    const late = abortable();
    const on = { businessId: business, personId: person, recheckMs: 5 };
    await followBoard(late, topics, on, {
      joinedAs: count(person),
      reach: count('tasks'),
      shown: count('inbox'),
    });
    await setTimeout(20);
    expect(late.aborted, 'stopped at once').toBe(true);
    expect(asked, 'asks nothing').toBe(0);
  });
});
