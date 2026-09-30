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

export interface LiveTopics {
  /** Hear `taskId` in `businessId`; the returned function stops. */
  subscribe(businessId: string, taskId: string, send: Send): () => void;
  /** Hear every task in `businessId` and `personId`'s own inbox there (INB-1f). */
  subscribeBoard(
    businessId: string,
    personId: string,
    send: (signal: BoardSignal) => void,
  ): () => void;
  /** Whether LISTEN has been in force since the last (re)connect, for `/api/health`. */
  readonly listening: boolean;
  close(): Promise<void>;
}

export async function startLiveTopics(listener: Listener): Promise<LiveTopics> {
  // `business:task` to its subscribers.
  const subscribers = new Map<string, Set<Send>>();
  // A business to its board streams.
  const boards = new Map<string, Set<Board>>();
  let listening = false;

  await listener.listen(
    LIVE_CHANNEL,
    (payload) => {
      hand(payload, subscribers, boards);
    },
    () => {
      if (listening) {
        for (const sends of subscribers.values()) for (const send of sends) send('resync');
        for (const set of boards.values()) for (const board of set) board.send({ kind: 'resync' });
      }
      listening = true;
    },
  );

  return {
    subscribe(businessId, taskId, send) {
      const key = `${businessId}:${taskId}`;
      const sends = subscribers.get(key) ?? new Set<Send>();
      subscribers.set(key, sends.add(send));
      return () => {
        sends.delete(send);
        if (sends.size === 0 && subscribers.get(key) === sends) subscribers.delete(key);
      };
    },
    subscribeBoard(businessId, personId, send) {
      const board: Board = { personId, send };
      const set = boards.get(businessId) ?? new Set<Board>();
      boards.set(businessId, set.add(board));
      return () => {
        set.delete(board);
        if (set.size === 0 && boards.get(businessId) === set) boards.delete(businessId);
      };
    },
    get listening() {
      return listening;
    },
    async close() {
      listening = false;
      await listener.close();
    },
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
