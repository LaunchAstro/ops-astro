// SPDX-License-Identifier: AGPL-3.0-only
//
// T2f: the live task channel's fan-out. One listen-only connection hears every
// business's `business:kind:topic` (migration 0035) and hands each only to
// subscribers filed under that business: the one their session was admitted
// to, never one a caller named. After a reconnect every subscriber resyncs,
// since whatever changed in between was never heard.
//
// INB-1f adds the board's subscribers: a tab's one stream hears every task
// topic of its business (each asked per event before it is said) and only its
// own person's inbox topic, `business:inbox:person` (migration 0043).

import type { Listener } from '../../packages/core-records/src/index.ts';

export const LIVE_CHANNEL = 'ops_astro_live';

export type LiveSignal = 'invalidate' | 'resync';

/** A tab's name for one task's topic, as the stream and the presence routes take it. */
export const TOPIC: RegExp =
  /^task:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

type Send = (signal: LiveSignal) => void;

/** What a board stream hears: a task named, its own inbox, or a resync. */
export type BoardSignal =
  | { readonly kind: 'task'; readonly taskId: string }
  | { readonly kind: 'inbox' }
  | { readonly kind: 'resync' };

interface Board {
  readonly personId: string;
  readonly send: (signal: BoardSignal) => void;
}

/** Ends a stream, resolving once none of its questions is in flight. */
type Stop = () => Promise<void>;

export interface LiveTopics {
  /** Hear `taskId` in `businessId`, `stop` ending the stream; the returned function stops hearing. */
  subscribe(businessId: string, taskId: string, send: Send, stop?: Stop): () => void;
  /** Hear every task in `businessId` and `personId`'s own inbox there (INB-1f); as above. */
  subscribeBoard(
    businessId: string,
    personId: string,
    send: (signal: BoardSignal) => void,
    stop: Stop,
  ): () => void;
  /** Whether LISTEN has been in force since the last (re)connect, for `/api/health`. */
  readonly listening: boolean;
  /** Stops every stream, waiting out their questions in flight, then stops listening; one admitted meanwhile is stopped at once. */
  close(): Promise<void>;
}

export async function startLiveTopics(listener: Listener): Promise<LiveTopics> {
  // `business:task` to its subscribers.
  const subscribers = new Map<string, Set<Send>>();
  // A business to its board streams.
  const boards = new Map<string, Set<Board>>();
  const held: Held = { stops: new Set<Stop>(), stopping: undefined };
  let listening = false;

  await listener.listen(
    LIVE_CHANNEL,
    (payload) => hand(payload, subscribers, boards),
    () => {
      if (listening) {
        for (const sends of subscribers.values()) for (const send of sends) send('resync');
        for (const set of boards.values()) for (const board of set) board.send({ kind: 'resync' });
      }
      listening = true;
    },
  );

  return {
    subscribe(businessId, taskId, send, stop) {
      const key = `${businessId}:${taskId}`;
      const sends = subscribers.get(key) ?? new Set<Send>();
      subscribers.set(key, sends.add(send));
      return holding(held, stop, () => {
        sends.delete(send);
        if (sends.size === 0 && subscribers.get(key) === sends) subscribers.delete(key);
      });
    },
    subscribeBoard(businessId, personId, send, stop) {
      const board: Board = { personId, send };
      const set = boards.get(businessId) ?? new Set<Board>();
      boards.set(businessId, set.add(board));
      return holding(held, stop, () => {
        set.delete(board);
        if (set.size === 0 && boards.get(businessId) === set) boards.delete(businessId);
      });
    },
    get listening() {
      return listening;
    },
    async close() {
      listening = false;
      await closeAll(held, listener);
    },
  };
}

/** The streams' stops, and once the topics are closing, the stops under way. */
interface Held {
  readonly stops: Set<Stop>;
  stopping: Promise<void>[] | undefined;
}

/**
 * Marks the topics closing, then stops every stream and waits them out before
 * the listener closes, and again after it: a stream admitted meanwhile is
 * stopped as it comes, and waited out too.
 */
async function closeAll(held: Held, listener: Listener): Promise<void> {
  held.stopping = [];
  held.stopping.push(...Array.from(held.stops, async (stop) => await stop()));
  await settle(held.stopping);
  await listener.close();
  await settle(held.stopping);
}

async function settle(stopping: Promise<void>[]): Promise<void> {
  while (stopping.length > 0) {
    // eslint-disable-next-line no-await-in-loop -- until no stop is left under way.
    await Promise.allSettled(stopping.splice(0));
  }
}

/** `unsubscribe`, with the stream's `stop` held for `close` until it runs; once closing, stopped at once. */
function holding(held: Held, stop: Stop | undefined, unsubscribe: () => void): () => void {
  if (stop) held.stops.add(stop);
  if (stop && held.stopping) held.stopping.push(stop());
  return () => {
    if (stop) held.stops.delete(stop);
    unsubscribe();
  };
}

/** One `business:kind:topic` to its hearers: a task to its own and to its business's boards, an inbox to its person's boards. */
function hand(
  payload: string,
  subscribers: ReadonlyMap<string, ReadonlySet<Send>>,
  boards: ReadonlyMap<string, ReadonlySet<Board>>,
): void {
  const [business, kind, topic, ...rest] = payload.split(':');
  if (business === undefined || topic === undefined || rest.length > 0) return;
  if (kind === 'task') {
    for (const send of subscribers.get(`${business}:${topic}`) ?? []) send('invalidate');
    for (const board of boards.get(business) ?? []) board.send({ kind: 'task', taskId: topic });
  } else if (kind === 'inbox') {
    for (const board of boards.get(business) ?? []) {
      if (board.personId === topic) board.send({ kind: 'inbox' });
    }
  }
}
