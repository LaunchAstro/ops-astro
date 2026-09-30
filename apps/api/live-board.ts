// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1f: the board screen's one stream per tab, on T2f's content-free
// channel. `resync` on connect and after the listener reconnects, and when a
// task the caller holds read on is trashed or their grants move (a revoked
// read), so the board refetches and is never sent the task; `invalidate`
// naming a task the caller may read now, by the grants `inbox.read` asks;
// `inbox` when what `inbox.read` shows the caller changed (their topic names
// no item, so a change to an item about a task they cannot read says nothing);
// `closed` the first time the caller may no longer hold the stream. Signals that arrive while one batch is being asked
// merge into the next, and a resync stands for every inbox change before it.
//
// The stream hears one person's inbox topic, the person the bearer resolves
// to. Each batch asks the join again, and so does each task read or changed
// inbox digest before its frame is written: when the bearer now resolves to
// another person, the old topic is dropped, the new person's is heard, and
// nothing is said until the stream's own recheck tells the tab `resync`, so no
// signal of the old person's times a frame for the new one.
//
// Stopping the stream (the tab leaving, or the topics closing) ends its
// recheck, and the stream lets go only once no question it asked is in
// flight, so none reaches a pool that closes after it.

import type { SSEStreamingApi } from 'hono/streaming';
import type { BoardSignal, LiveTopics } from './live.ts';

export interface BoardQuestions {
  /** The person the bearer resolves to now, if they may still hold the stream. */
  readonly joinedAs: () => Promise<string | undefined>;
  /**
   * Whether the caller may read this task now; `'gone'` when it is trashed and
   * they still hold read on it: told to refetch, never sent the task.
   */
  readonly reads: (taskId: string) => Promise<boolean | 'gone'>;
  /** A digest of the grants the caller holds now; when it moves, the board refetches. */
  readonly reach?: () => Promise<string | undefined>;
  /** A digest of what `inbox.read` shows `personId` now; undefined when it may not be read. */
  readonly shown: (personId: string) => Promise<string | undefined>;
}

type Heard = BoardSignal | { readonly kind: 'check' };

const noop = (): void => {};

/** The person whose inbox the stream hears, and what their inbox showed when last said. */
interface Bound {
  personId: string;
  shown: string | undefined;
  /** The caller's grants when last resynced: a revoked read changes nothing else it hears. */
  reach: string | undefined;
  /** Rebound and not yet told: every signal waits for the recheck's `resync`, which it follows. */
  owed: boolean;
  unsubscribe: () => void;
  /** The batch being asked; the stream lets go only once it is done. */
  asking: Promise<void>;
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
  let finished = noop;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const stop = async (): Promise<void> => {
    stream.abort();
    await done;
  };
  const bound: Bound = {
    personId: on.personId,
    shown: undefined,
    reach: undefined,
    owed: false,
    unsubscribe: () => {},
    asking: Promise.resolve(),
  };
  const bind = (personId: string): void => {
    bound.unsubscribe();
    bound.personId = personId;
    bound.unsubscribe = topics.subscribeBoard(on.businessId, personId, hear, stop);
  };
  const hear = batch(stream, ask, bound, bind);
  bind(on.personId);
  const timer = setInterval(() => hear({ kind: 'check' }), on.recheckMs);
  try {
    // Taken after subscribing and before the resync the tab reads from, so a
    // change between the two is either in the tab's read or said after it.
    if (!stream.aborted) await resyncs(stream, ask, bound);
    await ended;
  } finally {
    clearInterval(timer);
    await bound.asking;
    bound.unsubscribe();
    finished();
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
      (pending.check || (!bound.owed && (pending.resync || pending.inbox || tasks.size > 0)))
    ) {
      const { check } = pending;
      pending.check = false;
      // eslint-disable-next-line no-await-in-loop -- one batch is asked before the next.
      if ((await rejoin(stream, ask, bound, bind)) === 'closed') return;
      if (bound.owed && !check) continue;
      // A rebind owes the recheck's resync; a revoked read moves only the reach.
      // eslint-disable-next-line no-await-in-loop
      pending.resync ||= bound.owed || (check && (await ask.reach?.()) !== bound.reach);
      bound.owed = false;
      const { resync, inbox } = pending;
      const named = [...tasks];
      pending.resync = pending.inbox = false;
      tasks.clear();
      // eslint-disable-next-line no-await-in-loop
      if (resync) await resyncs(stream, ask, bound);
      // eslint-disable-next-line no-await-in-loop
      if ((await say(stream, ask, named, bound, inbox, bind)) === 'closed') return;
    }
  };
  let queued = false;
  const wake = (): void => {
    if (queued) return;
    queued = true;
    bound.asking = bound.asking
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

/** A frame, unless the stream ended while a question before it was asked. */
async function send(stream: SSEStreamingApi, event: string, data = ''): Promise<void> {
  if (!stream.aborted) await stream.writeSSE({ event, data });
}

/**
 * The join asked again: `closed` (said, and the stream ended) when it is
 * refused; `rebound` when the bearer now resolves to another person, whose
 * topic replaces the previous one's; `same` otherwise.
 */
async function rejoin(
  stream: SSEStreamingApi,
  ask: BoardQuestions,
  bound: Bound,
  bind: (personId: string) => void,
): Promise<'closed' | 'rebound' | 'same'> {
  const personId = await ask.joinedAs();
  if (personId === undefined) {
    await send(stream, 'closed');
    stream.abort();
    return 'closed';
  }
  if (personId === bound.personId) return 'same';
  bind(personId);
  bound.owed = true;
  return 'rebound';
}

/** A resync stands for every inbox change so far: what it shows is taken first. */
async function resyncs(stream: SSEStreamingApi, ask: BoardQuestions, bound: Bound): Promise<void> {
  bound.shown = await ask.shown(bound.personId);
  bound.reach = await ask.reach?.();
  await send(stream, 'resync');
}

/**
 * Each named task the caller reads now, by its identifier only, the join asked
 * again after the read so an answer that finished after the bearer moved is
 * dropped; then the inbox, if what it shows moved, the join asked again the
 * same way before the digest is kept or said.
 */
async function say(
  stream: SSEStreamingApi,
  ask: BoardQuestions,
  named: readonly string[],
  bound: Bound,
  inbox: boolean,
  bind: (personId: string) => void,
): Promise<'closed' | 'rebound' | 'same'> {
  for (const taskId of named) {
    // eslint-disable-next-line no-await-in-loop -- in the order they were heard.
    const access = await ask.reads(taskId);
    if (access === false) continue;
    // eslint-disable-next-line no-await-in-loop
    const joined = await rejoin(stream, ask, bound, bind);
    if (joined !== 'same') return joined;
    // eslint-disable-next-line no-await-in-loop
    if (access === 'gone') await resyncs(stream, ask, bound);
    // eslint-disable-next-line no-await-in-loop
    else await send(stream, 'invalidate', taskId);
  }
  if (!inbox) return 'same';
  const now = await ask.shown(bound.personId);
  if (now === undefined || now === bound.shown) return 'same';
  const joined = await rejoin(stream, ask, bound, bind);
  if (joined !== 'same') return joined;
  bound.shown = now;
  await send(stream, 'inbox');
  return 'same';
}
