// SPDX-License-Identifier: AGPL-3.0-only
import type { SSEStreamingApi } from 'hono/streaming';
import { expect, it } from 'vitest';
import { follow } from '../../apps/api/app.ts';
import { startLiveTopics } from '../../apps/api/live.ts';
import type { Listener } from '../../packages/core-records/src/index.ts';

it('a task stream admitted during topic shutdown cannot write after abort', async () => {
  const onAbort: (() => void)[] = [];
  const writes: { event: string; afterAbort: boolean }[] = [];
  let aborted = false;
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
  const topics = await startLiveTopics({
    listen: (_channel: string, _payload: unknown, onListening: () => void) => {
      onListening();
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  } as unknown as Listener);
  await topics.close();
  await follow(stream, { topics, recheckMs: 100_000 }, 'business', 'task',
    () => Promise.resolve('task'));
  expect(writes.filter((frame) => frame.afterAbort)).toEqual([]);
});
