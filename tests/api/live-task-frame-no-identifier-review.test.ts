// SPDX-License-Identifier: AGPL-3.0-only
import type { SSEStreamingApi } from 'hono/streaming';
import { expect, it, vi } from 'vitest';
import { follow } from '../../apps/api/app.ts';
import type { LiveTopics } from '../../apps/api/live.ts';

it('a dedicated task stream frame carries no task or client identifier', async () => {
  const taskId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const frames: { event: string; data: string }[] = [];
  const onAbort: (() => void)[] = [];
  let aborted = false;
  const stream = {
    get aborted() { return aborted; },
    onAbort(callback: () => void) { onAbort.push(callback); },
    writeSSE(frame: { event: string; data: string }) {
      frames.push(frame);
      return Promise.resolve();
    },
    abort() {
      if (aborted) return;
      aborted = true;
      for (const callback of onAbort) callback();
    },
  } as unknown as SSEStreamingApi;
  const topics = {
    subscribe: () => () => {},
  } as unknown as LiveTopics;
  const running = follow(stream, { topics, recheckMs: 100_000 }, 'business', taskId,
    () => Promise.resolve(taskId));
  try {
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    expect(frames.every((frame) => frame.data === '')).toBe(true);
  } finally {
    stream.abort();
    await running;
  }
});
