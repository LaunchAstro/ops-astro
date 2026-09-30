// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1f: closing the live topics stops every board stream, and resolves only
// once no question a board asked is still in flight. The pool closes after
// it, so a recheck that was running can never send its next statement down a
// connection that has already ended.

import type { SSEStreamingApi } from 'hono/streaming';
import { setTimeout } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import type { Listener } from '../../packages/core-records/src/index.ts';
import { followBoard } from '../../apps/api/live-board.ts';
import { startLiveTopics } from '../../apps/api/live.ts';

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

describe('INB-1 live board stop', () => {
  it('closing the topics stops the board, waits for its question in flight, and asks nothing after', async () => {
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
    const person = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const running = followBoard(
      stream,
      topics,
      { businessId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', personId: person, recheckMs: 5 },
      {
        // The recheck's join is held open: a query in flight when close is called.
        joinedAs: async () => {
          asked += 1;
          await held;
          return person;
        },
        reads: () => Promise.resolve(true),
        shown: () => Promise.resolve('inbox'),
      },
    );
    await vi.waitFor(() => expect(asked).toBe(1));

    const closing = topics.close();
    const first = await Promise.race([closing.then(() => 'closed'), setTimeout(50, 'waiting')]);
    expect(stream.aborted, 'close ends the board stream').toBe(true);
    expect(first, 'close waits for the question in flight').toBe('waiting');

    finish();
    await closing;
    await running;
    const atClose = asked;
    await setTimeout(50);
    expect(asked, 'nothing is asked once close has resolved').toBe(atClose);
  });
});
