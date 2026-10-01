// SPDX-License-Identifier: AGPL-3.0-only
//
// One task's open stream, moved out of app.ts whole when the main merge joined it past the
// 1000-line limit.

import type { SSEStreamingApi } from 'hono/streaming';
import type { CommandRefusal } from '../../packages/core-commands/src/index.ts';
import type { LiveSignal, LiveTopics } from './live.ts';
import { RECHECK_MS } from './live-follow.ts';

const noop = (): void => {};
const RANK = { check: 0, invalidate: 1, resync: 2 } as const;

/**
 * One open stream: `resync` once subscribed, then each signal once the caller
 * is asked again, and `closed` the first time the answer is no. Signals that
 * arrive while one is pending merge into it, the strongest kept. Stopping it
 * (the tab leaving, or the topics closing) lets go only once no question it
 * asked is in flight.
 */
export async function follow(
  stream: SSEStreamingApi,
  live: { readonly topics: LiveTopics; readonly recheckMs?: number },
  businessId: string,
  taskId: string,
  may: () => Promise<string | CommandRefusal>,
): Promise<void> {
  const ended = new Promise<void>((resolve) => {
    stream.onAbort(resolve);
  });
  let pending: LiveSignal | 'check' | null = null;
  let chain = Promise.resolve();
  const send = async (): Promise<void> => {
    const signal = pending;
    pending = null;
    if (signal === null || stream.aborted) return;
    const allowed = typeof (await may()) === 'string';
    // The tab may have left while the caller was asked: nothing is written after.
    if (stream.aborted) return;
    if (!allowed) {
      await stream.writeSSE({ event: 'closed', data: '' });
      stream.abort();
    } else if (signal !== 'check') await stream.writeSSE({ event: signal, data: '' });
  };
  const want = (signal: LiveSignal | 'check'): void => {
    if (pending === null) chain = chain.then(send).catch(() => stream.abort());
    if (pending === null || RANK[signal] > RANK[pending]) pending = signal;
  };
  let finished = noop;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const stop = async (): Promise<void> => {
    stream.abort();
    await done;
  };
  const unsubscribe = live.topics.subscribe(businessId, taskId, want, stop);
  const timer = setInterval(() => want('check'), live.recheckMs ?? RECHECK_MS);
  try {
    // Topics closing stop a stream as it subscribes: nothing is written after.
    if (!stream.aborted) await stream.writeSSE({ event: 'resync', data: '' });
    await ended;
  } finally {
    clearInterval(timer);
    await chain;
    unsubscribe();
    finished();
  }
}
