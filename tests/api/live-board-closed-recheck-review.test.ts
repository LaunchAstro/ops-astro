// SPDX-License-Identifier: AGPL-3.0-only
import type { SSEStreamingApi } from 'hono/streaming';
import { expect, it, vi } from 'vitest';
import type { Listener } from '../../packages/core-records/src/index.ts';
import { followBoard } from '../../apps/api/live-board.ts';
import { startLiveTopics } from '../../apps/api/live.ts';

it('a board recheck cannot write resync after its stream aborts', async () => {
  const personId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const businessId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const topics = await startLiveTopics({
    listen: (_channel: string, _payload: unknown, onListening: () => void) => {
      onListening();
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  } as unknown as Listener);
  let aborted = false;
  const onAbort: (() => void)[] = [];
  const writes: { event: string; afterAbort: boolean }[] = [];
  const stream = {
    get aborted() { return aborted; },
    onAbort(callback: () => void) { onAbort.push(callback); },
    writeSSE(frame: { event: string }) {
      writes.push({ event: frame.event, afterAbort: aborted });
      return Promise.resolve();
    },
    abort() {
      if (aborted) return;
      aborted = true;
      for (const callback of onAbort) callback();
    },
  } as unknown as SSEStreamingApi;
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let reachCalls = 0;
  const running = followBoard(stream, topics, { businessId, personId, recheckMs: 5 }, {
    joinedAs: () => Promise.resolve(personId),
    reads: () => Promise.resolve(false),
    shown: () => Promise.resolve('inbox'),
    reach: async () => {
      reachCalls += 1;
      if (reachCalls === 2) await held;
      return reachCalls === 1 ? 'before' : 'after';
    },
  });
  try {
    await vi.waitFor(() => expect(reachCalls).toBe(2));
    stream.abort();
    release();
    await running;
    expect(writes.filter((frame) => frame.afterAbort)).toEqual([]);
  } finally {
    release();
    stream.abort();
    await topics.close();
  }
});
