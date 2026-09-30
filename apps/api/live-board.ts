// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1f: the board screen's one stream per tab, on T2f's content-free
// channel. `resync` on connect and after the listener reconnects;
// `invalidate` naming a task the caller may read now, asked per event as the
// task's own stream asks it; `inbox` when what `inbox.read` shows the caller
// changed (their topic names no item, so a change to an item about a task
// they cannot read says nothing); `closed` the first time the caller may no
// longer hold the stream. Signals that arrive while one batch is being asked
// merge into the next, and a resync stands for everything it would have said.
//
// The stream hears one person's inbox topic, the person the bearer resolves
// to. Each batch asks the join again: when the bearer now resolves to another
// person, the old topic is dropped before anything is said, the new person's
// is heard, and the tab is told `resync`, as a fresh connection would be. A
// signal heard for the old person is never said.

import type { SSEStreamingApi } from 'hono/streaming';
import type { BoardSignal, LiveTopics } from './live.ts';

export interface BoardQuestions {
  /** The person the bearer resolves to now, if they may still hold the stream. */
  readonly joinedAs: () => Promise<string | undefined>;
  /** Whether the caller may read this task now. */
  readonly reads: (taskId: string) => Promise<boolean>;
  /** A digest of what `inbox.read` shows `personId` now; undefined when it may not be read. */
  readonly shown: (personId: string) => Promise<string | undefined>;
}

type Heard = BoardSignal | { readonly kind: 'check' };

/** The person whose inbox the stream hears, and what their inbox showed when last said. */
interface Bound {
  personId: string;
  shown: string | undefined;
  unsubscribe: () => void;
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
  const bound: Bound = { personId: on.personId, shown: undefined, unsubscribe: () => {} };
  const bind = (personId: string): void => {
    bound.unsubscribe();
    bound.personId = personId;
    bound.unsubscribe = topics.subscribeBoard(on.businessId, personId, hear);
  };
  const hear = batch(stream, ask, bound, bind);
  bind(on.personId);
  const timer = setInterval(() => hear({ kind: 'check' }), on.recheckMs);
  try {
    // Taken after subscribing and before the resync the tab reads from, so a
    // change between the two is either in the tab's read or said after it.
    await resyncs(stream, ask, bound);
    await ended;
  } finally {
    clearInterval(timer);
    bound.unsubscribe();
  }
}

/**
 * What the stream has heard and not yet said, asked and said a batch at a
 * time; the answer takes each signal, and `check` asks the join again alone.
 */
function batch(
  stream: SSEStreamingApi,
  ask: BoardQuestions,
  bound: Bound,
  bind: (personId: string) => void,
): (signal: Heard) => void {
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
      const personId = await ask.joinedAs();
      if (personId === undefined) {
        // eslint-disable-next-line no-await-in-loop
        await stream.writeSSE({ event: 'closed', data: '' });
        stream.abort();
        return;
      }
      if (personId !== bound.personId) {
        // The inbox heard so far was the previous person's: dropped, not said.
        bind(personId);
        // eslint-disable-next-line no-await-in-loop
        await resyncs(stream, ask, bound);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      if (resync) await resyncs(stream, ask, bound);
      // eslint-disable-next-line no-await-in-loop
      else await say(stream, ask, named, bound, inbox);
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

/** A resync stands for every inbox change so far: what it shows is taken first. */
async function resyncs(stream: SSEStreamingApi, ask: BoardQuestions, bound: Bound): Promise<void> {
  bound.shown = await ask.shown(bound.personId);
  await stream.writeSSE({ event: 'resync', data: '' });
}

/** Each named task the caller reads now, by its identifier only; then the inbox, if what it shows moved. */
async function say(
  stream: SSEStreamingApi,
  ask: BoardQuestions,
  named: readonly string[],
  bound: Bound,
  inbox: boolean,
): Promise<void> {
  for (const taskId of named) {
    // eslint-disable-next-line no-await-in-loop -- in the order they were heard.
    if (await ask.reads(taskId)) await stream.writeSSE({ event: 'invalidate', data: taskId });
  }
  if (!inbox) return;
  const now = await ask.shown(bound.personId);
  if (now === undefined || now === bound.shown) return;
  bound.shown = now;
  await stream.writeSSE({ event: 'inbox', data: '' });
}
