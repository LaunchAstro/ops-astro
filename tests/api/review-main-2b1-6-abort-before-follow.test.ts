// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-MAIN-2B1-6, red proof: a live stream aborted before `follow` starts
// never ends.
//
// apps/api/app.ts (the `/live` route) splits the SSE stream with `sharesOf`,
// then awaits `closed` writes and `seatOf` (a token check and a DB read)
// before `follow` / `followBoard` run on the shares. A tab that drops in that
// window aborts the stream, which aborts each share, and a share's `onAbort`
// only pushes a listener: one added after the share ended is never called.
// `follow` waits on `new Promise((r) => stream.onAbort(r))`, so it seats the
// person in the presence book, starts its recheck timer, and never returns.
// The person shows as viewing until restart, and `topics.close()` (SIGTERM)
// waits forever on the stream's `done`. Hono's own `StreamingApi.onAbort`
// does not replay either, so a stream aborted before `sharesOf` runs leaves
// its shares looking aborted (`share.aborted` reads the stream) but never
// ended.
//
// The fake stream below keeps Hono's semantics: `abort` runs once, and a
// listener added afterwards is not called.
//
// Passes once fixed: a share's `onAbort` (and `sharesOf` for a stream that is
// already aborted) calls a late listener at once, or `follow` / `followBoard`
// check `stream.aborted` before waiting on `ended`; either way the stream
// returns, its seats leave, and the topics close.

import type { SSEStreamingApi } from 'hono/streaming';
import { setTimeout } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { Listener } from '../../packages/core-records/src/index.ts';
import { followBoard } from '../../apps/api/live-board.ts';
import { BOARD, follow, sharesOf, type Watching } from '../../apps/api/live-follow.ts';
import { createLivePresence } from '../../apps/api/live-presence.ts';
import { startLiveTopics, type LiveTopics } from '../../apps/api/live.ts';

const business = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const person = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const task = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BOUND_MS = 200;

/** An SSE stream as Hono's: `abort` runs its listeners once; a late listener is never called. */
function honoLike(): SSEStreamingApi {
  let aborted = false;
  const listeners: (() => void)[] = [];
  return {
    get aborted() {
      return aborted;
    },
    onAbort(listener: () => void) {
      listeners.push(listener);
    },
    writeSSE: () => Promise.resolve(),
    abort() {
      if (aborted) return;
      aborted = true;
      for (const listener of listeners) listener();
    },
  } as unknown as SSEStreamingApi;
}

async function topicsNow(): Promise<LiveTopics> {
  const listener = {
    listen: (_channel: string, _payload: unknown, onListening: () => void) => {
      onListening();
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  } as unknown as Listener;
  return await startLiveTopics(listener);
}

const asks: Watching = {
  businessId: business,
  atDoor: (taskIds) => Promise.resolve(taskIds.map(() => task)),
  again: () => Promise.resolve(person),
};

/** 'resolved', or 'hung' when `running` has not settled within the bound. */
async function bounded(running: Promise<unknown>): Promise<'resolved' | 'hung'> {
  return await Promise.race([
    running.then(() => 'resolved' as const),
    setTimeout(BOUND_MS, 'hung' as const),
  ]);
}

// oxlint-disable-next-line max-lines-per-function -- one table of cases for follow and followBoard
describe('REVIEW-MAIN-2B1-6: a live stream aborted before follow starts never ends', () => {
  it.each([
    ['the tab drops between sharesOf and follow (while seatOf is awaited)', false],
    ['the Hono stream aborted before sharesOf ran', true],
  ])(
    'REVIEW-MAIN-2B1-6: follow on a share whose stream aborted when %s ends, leaves its seat, and lets topics.close() resolve',
    async (_when, beforeShares) => {
      const topics = await topicsNow();
      const presence = createLivePresence();
      const stream = honoLike();
      if (beforeShares) stream.abort();
      const [share] = sharesOf(stream, [undefined]);
      if (share === undefined) throw new Error('sharesOf gave no share');
      // The tab drops while the route awaits `closed` writes and seatOf.
      stream.abort();
      expect(share.aborted, 'the share reads as aborted before follow starts').toBe(true);

      const session = {
        sessionId: 'seat-1',
        personId: person,
        name: 'Ana Bell',
        side: 'staff' as const,
      };
      const running = follow(
        share,
        { topics, recheckMs: 60_000 },
        [{ label: `task:${task}`, taskId: task }],
        asks,
        { session, presence, sitter: async () => await Promise.resolve(session) },
      );

      expect
        .soft(
          await bounded(running),
          `follow on an aborted share ends within ${String(BOUND_MS)} ms`,
        )
        .toBe('resolved');
      expect.soft(presence.held, 'the presence book holds no seat for the dropped tab').toBe(0);
      expect
        .soft(
          await bounded(topics.close()),
          `topics.close() resolves within ${String(BOUND_MS)} ms`,
        )
        .toBe('resolved');
    },
  );

  it('REVIEW-MAIN-2B1-6: followBoard on a board share whose stream aborted before it started ends, and lets topics.close() resolve', async () => {
    const topics = await topicsNow();
    const stream = honoLike();
    const shares = sharesOf(stream, [undefined, BOARD]);
    const board = shares[1];
    if (board === undefined) throw new Error('sharesOf gave no board share');
    // The tab drops while the route awaits seatOf, before followBoardOn runs.
    stream.abort();
    expect(board.aborted, 'the board share reads as aborted before followBoard starts').toBe(true);

    const running = followBoard(
      board,
      topics,
      { businessId: business, personId: person, recheckMs: 60_000 },
      {
        joinedAs: () => Promise.resolve(person),
        reach: () => Promise.resolve('tasks'),
        shown: () => Promise.resolve('inbox'),
      },
    );

    expect
      .soft(
        await bounded(running),
        `followBoard on an aborted share ends within ${String(BOUND_MS)} ms`,
      )
      .toBe('resolved');
    expect
      .soft(await bounded(topics.close()), `topics.close() resolves within ${String(BOUND_MS)} ms`)
      .toBe('resolved');
  });
});
