// SPDX-License-Identifier: AGPL-3.0-only
//
// Review proof (REVIEW-MAIN-B1 p02-2, red on d25e97e02). The C4 live route
// (apps/api/app.ts, `streamSSE` callback) splits the stream with `sharesOf`,
// then awaits `seatOf` (database questions) before `followBoardOn` hands the
// board share to `followBoard`. A tab that leaves during that await aborts the
// stream, and the share with it, before `followBoard` subscribes to `onAbort`.
// `followBoard` waits on an abort that already happened: it never ends, its
// board subscription and recheck timer stay, and closing the topics (server
// shutdown) waits on its stop for ever.

import { SSEStreamingApi } from 'hono/streaming';
import { setTimeout } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { Listener } from '../../packages/core-records/src/index.ts';
import { followBoard } from '../../apps/api/live-board.ts';
import { sharesOf } from '../../apps/api/live-follow.ts';
import { startLiveTopics } from '../../apps/api/live.ts';

const business = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const person = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('p02-2: a board stream aborted before followBoard starts', () => {
  it('ends, and does not hold the topics open', async () => {
    const listener = {
      listen: (_channel: string, _payload: unknown, onListening: () => void) => {
        onListening();
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    } as unknown as Listener;
    const topics = await startLiveTopics(listener);
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const stream = new SSEStreamingApi(writable, readable);
    // As app.ts does for a board-only C4 stream: one share, labelled for the board.
    const [share] = sharesOf(stream, ['board']);
    if (share === undefined) throw new Error('one share');
    // The tab leaves while the route awaits `seatOf`, before `followBoardOn`.
    stream.abort();

    const asked: string[] = [];
    const running = followBoard(
      share,
      topics,
      { businessId: business, personId: person, recheckMs: 20 },
      {
        joinedAs: () => Promise.resolve(person),
        reach: () => Promise.resolve(void asked.push('reach')).then(() => 'tasks'),
        shown: () => Promise.resolve('inbox'),
      },
    );
    const ended = await Promise.race([running.then(() => 'ended'), setTimeout(500, 'hung')]);
    const closed = await Promise.race([
      topics.close().then(() => 'closed'),
      setTimeout(500, 'hung'),
    ]);
    expect(asked, 'an aborted stream asks nothing').toEqual([]);
    expect(
      { ended, closed },
      'p02-2 followBoard hangs on an already-aborted stream: it never ends and topics.close() never resolves',
    ).toEqual({ ended: 'ended', closed: 'closed' });
  });
});
