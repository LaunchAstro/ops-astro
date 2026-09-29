// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1f: the board screen's one stream per tab, on T2f's content-free
// channel. `resync` on connect and after the listener reconnects;
// `invalidate` naming a task the caller may read now, asked per event as the
// task's own stream asks it; `inbox` when the caller's own items change;
// `closed` the first time the caller may no longer hold the stream. Signals
// that arrive while one batch is being asked merge into the next, and a
// resync stands for everything it would have said.

import type { SSEStreamingApi } from 'hono/streaming';
import type { BoardSignal, LiveTopics } from './live.ts';

export interface BoardQuestions {
  /** Whether the caller may still hold the stream, asked again each time. */
  readonly stillJoined: () => Promise<boolean>;
  /** Whether the caller may read this task now. */
  readonly reads: (taskId: string) => Promise<boolean>;
}

export async function followBoard(
  stream: SSEStreamingApi,
  topics: LiveTopics,
  on: { readonly businessId: string; readonly personId: string; readonly recheckMs: number },
  ask: BoardQuestions,
): Promise<void> {
  const ended = new Promise<void>((resolve) => {
    stream.onAbort(resolve);
  });
  const hear = batch(stream, ask);
  const unsubscribe = topics.subscribeBoard(on.businessId, on.personId, hear);
  const timer = setInterval(() => hear({ kind: 'check' }), on.recheckMs);
  try {
    await stream.writeSSE({ event: 'resync', data: '' });
    await ended;
  } finally {
    clearInterval(timer);
    unsubscribe();
  }
}

/**
 * What the stream has heard and not yet said, asked and said a batch at a
 * time; the answer takes each signal, and `check` asks the join again alone.
 */
function batch(
  stream: SSEStreamingApi,
  ask: BoardQuestions,
): (signal: BoardSignal | { readonly kind: 'check' }) => void {
  const tasks = new Set<string>();
  const pending = { resync: false, inbox: false, check: false };
  const drain = async (): Promise<void> => {
    while (
      !stream.aborted &&
      (pending.resync || pending.inbox || pending.check || tasks.size > 0)
    ) {
      const { resync, inbox } = pending;
      const named = [...tasks];
      pending.resync = pending.inbox = pending.check = false;
      tasks.clear();
      // eslint-disable-next-line no-await-in-loop -- one batch is asked before the next.
      if (!(await ask.stillJoined())) {
        // eslint-disable-next-line no-await-in-loop
        await stream.writeSSE({ event: 'closed', data: '' });
        stream.abort();
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      if (resync) await stream.writeSSE({ event: 'resync', data: '' });
      // eslint-disable-next-line no-await-in-loop
      else await say(stream, ask, named, inbox);
    }
  };
  let queued = false;
  let chain = Promise.resolve();
  const wake = (): void => {
    if (queued) return;
    queued = true;
    chain = chain
      .then(async () => {
        queued = false;
        return await drain();
      })
      .catch(() => stream.abort());
  };
  return (signal) => {
    if (signal.kind === 'task') tasks.add(signal.taskId);
    else pending[signal.kind] = true;
    wake();
  };
}

/** Each named task the caller reads now, by its identifier only; then the inbox. */
async function say(
  stream: SSEStreamingApi,
  ask: BoardQuestions,
  named: readonly string[],
  inbox: boolean,
): Promise<void> {
  for (const taskId of named) {
    // eslint-disable-next-line no-await-in-loop -- in the order they were heard.
    if (await ask.reads(taskId)) await stream.writeSSE({ event: 'invalidate', data: taskId });
  }
  if (inbox) await stream.writeSSE({ event: 'inbox', data: '' });
}
