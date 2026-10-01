// SPDX-License-Identifier: AGPL-3.0-only

import type { SSEStreamingApi } from 'hono/streaming';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { followBoard, type BoardQuestions } from '../../apps/api/live-board.ts';
import type { BoardSignal, LiveTopics } from '../../apps/api/live.ts';

const noop = (): void => {};
const ignoreSignal = (_signal: BoardSignal): void => {};

// eslint-disable-next-line max-lines-per-function -- two controlled identity changes
describe('INB-1 live identity rebind', () => {
  // eslint-disable-next-line max-lines-per-function -- one old-person signal after identity change
  it('an old-person inbox event cannot time a new-person resync', async () => {
    const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const frames: { event: string; data: string }[] = [];
    let aborted = false;
    let onAbort = noop;
    const stream = {
      get aborted() {
        return aborted;
      },
      onAbort(callback: () => void) {
        onAbort = callback;
      },
      writeSSE(frame: { event: string; data: string }) {
        frames.push(frame);
        return Promise.resolve();
      },
      abort() {
        aborted = true;
        onAbort();
      },
    } as unknown as SSEStreamingApi;
    let hear: (signal: BoardSignal) => void = ignoreSignal;
    const topics: LiveTopics = {
      subscribe: () => () => {},
      subscribeBoard: (_business, _person, send) => {
        hear = send;
        return () => {};
      },
      listening: true,
      close: () => Promise.resolve(),
    };
    let current = first;
    const ask: BoardQuestions = {
      joinedAs: () => Promise.resolve(current),
      reach: () => Promise.resolve('tasks'),
      shown: () => Promise.resolve('unchanged'),
    };
    const running = followBoard(
      stream,
      topics,
      {
        businessId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        personId: first,
        recheckMs: 60_000,
      },
      ask,
    );
    try {
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      current = second;
      hear({ kind: 'inbox' });
      await setImmediate();
      expect(frames).toStrictEqual([{ event: 'resync', data: '' }]);
    } finally {
      stream.abort();
      await running;
    }
  });

  // eslint-disable-next-line max-lines-per-function -- one controlled inbox read and identity change
  it('an in-flight old-person inbox digest cannot signal a remapped bearer', async () => {
    const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const frames: { event: string; data: string }[] = [];
    let aborted = false;
    let onAbort = noop;
    const stream = {
      get aborted() {
        return aborted;
      },
      onAbort(callback: () => void) {
        onAbort = callback;
      },
      writeSSE(frame: { event: string; data: string }) {
        frames.push(frame);
        return Promise.resolve();
      },
      abort() {
        aborted = true;
        onAbort();
      },
    } as unknown as SSEStreamingApi;
    let hear: (signal: BoardSignal) => void = ignoreSignal;
    const topics: LiveTopics = {
      subscribe: () => () => {},
      subscribeBoard: (_business, _person, send) => {
        hear = send;
        return () => {};
      },
      listening: true,
      close: () => Promise.resolve(),
    };
    let current = first;
    let reads = 0;
    let enterShown = noop;
    const showing = new Promise<void>((resolve) => {
      enterShown = resolve;
    });
    let finishShown: (digest: string) => void = noop;
    const pendingDigest = new Promise<string>((resolve) => {
      finishShown = resolve;
    });
    const ask: BoardQuestions = {
      joinedAs: () => Promise.resolve(current),
      reach: () => Promise.resolve('tasks'),
      shown: () => {
        reads += 1;
        if (reads === 1) return Promise.resolve('before');
        enterShown();
        return pendingDigest;
      },
    };
    const running = followBoard(
      stream,
      topics,
      {
        businessId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        personId: first,
        recheckMs: 60_000,
      },
      ask,
    );
    try {
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      hear({ kind: 'inbox' });
      await showing;
      current = second;
      finishShown('after');
      await setImmediate();
      expect(frames).toStrictEqual([{ event: 'resync', data: '' }]);
    } finally {
      stream.abort();
      await running;
    }
  });
});
