// SPDX-License-Identifier: AGPL-3.0-only
import type { SSEStreamingApi } from 'hono/streaming';
import { expect, it, vi } from 'vitest';
import { followBoard } from '../../apps/api/live-board.ts';
import type { BoardSignal, LiveTopics } from '../../apps/api/live.ts';

it('a board task event cannot name a task whose read grant is revoked during rejoin', async () => {
  const personId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const taskId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const writes: { event: string; data: string }[] = [];
  const onAbort: (() => void)[] = [];
  let aborted = false;
  const stream = {
    get aborted() { return aborted; },
    onAbort(callback: () => void) { onAbort.push(callback); },
    writeSSE(frame: { event: string; data: string }) {
      writes.push(frame);
      return Promise.resolve();
    },
    abort() {
      if (aborted) return;
      aborted = true;
      for (const callback of onAbort) callback();
    },
  } as unknown as SSEStreamingApi;
  let hear = (_signal: BoardSignal): void => {};
  const topics = {
    subscribeBoard: (_business: string, _person: string, send: (signal: BoardSignal) => void) => {
      hear = send;
      return () => {};
    },
  } as unknown as LiveTopics;
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let joins = 0;
  let canRead = true;
  const running = followBoard(stream, topics, {
    businessId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', personId, recheckMs: 100_000,
  }, {
    joinedAs: async () => {
      joins += 1;
      if (joins === 2) await held;
      return personId;
    },
    reads: () => Promise.resolve(canRead),
    shown: () => Promise.resolve('inbox'),
    reach: () => Promise.resolve('other grant keeps the board open'),
  });
  try {
    await vi.waitFor(() => expect(writes.some((frame) => frame.event === 'resync')).toBe(true));
    hear({ kind: 'task', taskId });
    await vi.waitFor(() => expect(joins).toBe(2));
    canRead = false;
    release();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(writes).not.toContainEqual({ event: 'invalidate', data: taskId });
  } finally {
    release();
    stream.abort();
    await running;
  }
});
