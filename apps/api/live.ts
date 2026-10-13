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
//
// C71 (CS-7.42) adds a team conversation's topic, `business:conversation:id`
// (migration 20261006235000): its own subscribers hear it as a task's hear theirs, and
// every board of its business is handed it, to say to a current member alone
// (`live-board.ts`). A task and a conversation are both records, so their ids
// share one key space and a subscriber is filed by business and id alone.
//
// P11: `business:settings:priority_stages` (migration 20261011105055) goes to
// every board of its business, since every task's rank derives from it.

import { randomUUID } from 'node:crypto';
import type { Listener } from '../../packages/core-records/src/index.ts';

export const LIVE_CHANNEL = 'ops_astro_live';

/**
 * A stream's question the sign-in provider could not answer (its key set
 * unreachable): not a refusal, so nothing is closed or said, and what was
 * due waits for the next check.
 */
export const UNANSWERED: unique symbol = Symbol('unanswered');
export type Unanswered = typeof UNANSWERED;

/** How long `/api/health` waits to hear its own probe back. */
export const PROBE_MS = 1_000;

export type LiveSignal = 'invalidate' | 'resync';

/** A tab's name for one task's topic, as the stream and the presence routes take it. */
export const TOPIC: RegExp =
  /^task:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

/** A tab's name for one team conversation's topic (C71), as the stream takes it. */
export const CONVERSATION_TOPIC: RegExp =
  /^conversation:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

/** One followed task or conversation, and the name the stream gives it: the caller's own topic. */
export interface Watch {
  readonly label: string;
  /** The record followed: a task's id, or a conversation's where `kind` says so. */
  readonly taskId: string;
  readonly kind?: 'conversation';
}

const MOST_TOPICS = 32;
export const TOPICS: string = `Name each topic once, as task:<id>, conversation:<id> or board, from one to ${String(MOST_TOPICS)}.`;

/** The board's stream (INB-1f) as one topic on the tab's stream: every frame it sends is labelled so. */
export const BOARD = 'board';

/** The topics a tab named, or undefined when any is malformed, repeated or too many. */
export function topicsOf(
  named: readonly string[],
): { readonly watches: readonly Watch[]; readonly board: boolean } | undefined {
  if (named.length === 0 || named.length > MOST_TOPICS) return undefined;
  if (new Set(named).size !== named.length) return undefined;
  const topics = named.filter((label) => label !== BOARD);
  const watches = topics.map((label) => watchOf(label));
  if (!watches.every((watch) => watch !== undefined)) return undefined;
  return { watches, board: topics.length < named.length };
}

/** A topic's kind and id, or undefined when it names neither a task nor a conversation. */
function watchOf(label: string): Watch | undefined {
  const task = TOPIC.exec(label)?.[1];
  if (task !== undefined) return { label, taskId: task };
  const conversation = CONVERSATION_TOPIC.exec(label)?.[1];
  return conversation === undefined
    ? undefined
    : { label, taskId: conversation, kind: 'conversation' };
}

type Send = (signal: LiveSignal) => void;

/** What a board stream hears: a task or a conversation named, its own inbox, the priority stages moving, or a resync. */
export type BoardSignal =
  | { readonly kind: 'task'; readonly taskId: string }
  | { readonly kind: 'conversation'; readonly conversationId: string }
  | { readonly kind: 'inbox' }
  | { readonly kind: 'priority' }
  | { readonly kind: 'resync' };

interface Board {
  readonly personId: string;
  readonly send: (signal: BoardSignal) => void;
}

/** Ends a stream, resolving once none of its questions is in flight. */
type Stop = () => Promise<void>;

export interface LiveTopics {
  /** Hear a task or a conversation (`recordId`) in `businessId`, `stop` ending the stream; the returned function stops hearing. */
  subscribe(businessId: string, recordId: string, send: Send, stop?: Stop): () => void;
  /** Hear every task in `businessId` and `personId`'s own inbox there (INB-1f); as above. */
  subscribeBoard(
    businessId: string,
    personId: string,
    send: (signal: BoardSignal) => void,
    stop: Stop,
  ): () => void;
  /** Whether LISTEN has been in force since the last (re)connect. */
  readonly listening: boolean;
  /**
   * Whether LISTEN hears now, for `/api/health`: `notify` sends a probe on the
   * channel, and only the probe heard back within `withinMs` is true. The
   * driver says nothing when the connection drops, so a listener cut off and
   * not yet listening again hears nothing, however the runtime database answers.
   */
  hears(notify: (payload: string) => Promise<void>, withinMs?: number): Promise<boolean>;
  /** Stops every stream, waiting out their questions in flight, then stops listening; one admitted meanwhile is stopped at once. */
  close(): Promise<void>;
}

export async function startLiveTopics(listener: Listener): Promise<LiveTopics> {
  // `business:task` to its subscribers.
  const subscribers = new Map<string, Set<Send>>();
  // A business to its board streams.
  const boards = new Map<string, Set<Board>>();
  const held: Held = { stops: new Set<Stop>(), stopping: undefined };
  const prober = createProber();
  let listening = false;

  await listener.listen(
    LIVE_CHANNEL,
    (payload) => prober.heard(payload) || hand(payload, subscribers, boards),
    () => {
      if (listening) resyncAll(subscribers, boards);
      listening = true;
    },
  );

  return {
    subscribe(businessId, recordId, send, stop) {
      const key = `${businessId}:${recordId}`;
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
    hears: async (notify, withinMs) => listening && (await prober.probe(notify, withinMs)),
    async close() {
      listening = false;
      held.closing ??= closeAll(held, listener);
      await held.closing;
    },
  };
}

/** After a reconnect, every subscriber resyncs: whatever changed in between was never heard. */
function resyncAll(
  subscribers: ReadonlyMap<string, ReadonlySet<Send>>,
  boards: ReadonlyMap<string, ReadonlySet<Board>>,
): void {
  for (const sends of subscribers.values()) for (const send of sends) send('resync');
  for (const set of boards.values()) for (const board of set) board.send({ kind: 'resync' });
}

/**
 * Health's probes: `probe` sends one through `notify` and answers whether the
 * listener heard it back within `withinMs`; `heard` takes a payload that is a
 * waiting probe, and answers false for any other.
 */
function createProber() {
  const waiting = new Map<string, () => void>();
  return {
    heard(payload: string): boolean {
      waiting.get(payload)?.();
      return waiting.has(payload);
    },
    async probe(notify: (payload: string) => Promise<void>, withinMs = PROBE_MS): Promise<boolean> {
      // Two parts, so every hand on the channel, this one included, takes it for no topic.
      const payload = `probe:${randomUUID()}`;
      let timer: NodeJS.Timeout | undefined;
      // The deadline bounds the notification's own transaction too: a send that stalls is not heard.
      const heard = new Promise<boolean>((resolve) => {
        waiting.set(payload, () => resolve(true));
        timer = setTimeout(() => resolve(false), withinMs);
        notify(payload).catch(() => resolve(false));
      });
      try {
        return await heard;
      } finally {
        clearTimeout(timer);
        waiting.delete(payload);
      }
    },
  };
}

/** The streams' stops, and once the topics are closing, the stops under way. */
interface Held {
  readonly stops: Set<Stop>;
  stopping: Promise<void>[] | undefined;
  /** The one shutdown, however many callers ask: each waits out every stream. */
  closing?: Promise<void>;
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

/** One `business:kind:topic` to its hearers: a task or a conversation to its own and to its business's boards, an inbox to its person's boards. */
function hand(
  payload: string,
  subscribers: ReadonlyMap<string, ReadonlySet<Send>>,
  boards: ReadonlyMap<string, ReadonlySet<Board>>,
): void {
  const [business, kind, topic, ...rest] = payload.split(':');
  if (business === undefined || topic === undefined || rest.length > 0) return;
  if (kind === 'task' || kind === 'conversation') {
    for (const send of subscribers.get(`${business}:${topic}`) ?? []) send('invalidate');
    const signal: BoardSignal =
      kind === 'task' ? { kind, taskId: topic } : { kind, conversationId: topic };
    for (const board of boards.get(business) ?? []) board.send(signal);
  } else if (kind === 'settings' && topic === 'priority_stages') {
    // Every rank derives from it (P11); each board's own digest decides whether to say so.
    for (const board of boards.get(business) ?? []) board.send({ kind: 'priority' });
  } else if (kind === 'inbox') {
    for (const board of boards.get(business) ?? []) {
      if (board.personId === topic) board.send({ kind: 'inbox' });
    }
  }
}
