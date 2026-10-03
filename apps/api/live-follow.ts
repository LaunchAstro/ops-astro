// SPDX-License-Identifier: AGPL-3.0-only
//
// C4's one stream per tab, from join to end, and C2's presence on it: the
// topics a tab names, and the loop that re-asks before every delivery. Moved
// out of app.ts unchanged in what it sends, with presence added.

import { randomUUID } from 'node:crypto';
import type { SSEStreamingApi } from 'hono/streaming';
import type { CommandRefusal, Viewer } from '../../packages/core-commands/src/index.ts';
import { TOPIC, type LiveSignal, type LiveTopics } from './live.ts';
import type { LivePresence } from './live-presence.ts';
import type { PresenceSession } from './presence.ts';

/** How a stream asks, for its business, whether its caller may still watch a task. */
export interface Watching {
  readonly businessId: string;
  /** At join, every topic in one transaction: the login's one authentication attempt, nothing else. */
  atDoor(taskIds: readonly string[]): Promise<readonly (string | CommandRefusal)[]>;
  /** Before each delivery and on the recheck: writes nothing. */
  again(taskId: string): Promise<string | CommandRefusal>;
}

/** One followed task, and the name the stream gives it: the caller's own topic. */
export interface Watch {
  readonly label: string;
  readonly taskId: string;
}

/** Who a seat is held for: the person the bearer resolves to, without the seat's id. */
export type Sitter = Omit<PresenceSession, 'sessionId'>;

/** A stream's seat in the presence book (C2): its id is handed to the tab alone. */
export interface Seated {
  readonly session: PresenceSession;
  readonly presence: LivePresence;
  /** Who the bearer resolves to now, asked before each delivery; undefined when no one. */
  sitter(): Promise<Sitter | undefined>;
}

/** A stream's seat for whoever `viewer` resolves to now, under a new id; none when no one. */
export async function seatFor(
  presence: LivePresence,
  viewer: () => Promise<Viewer | undefined>,
): Promise<Seated | undefined> {
  const sitter = async (): Promise<Sitter | undefined> => {
    const now = await viewer();
    return now && { personId: now.personId, name: now.name, side: now.staff ? 'staff' : 'client' };
  };
  const now = await sitter();
  return now && { presence, session: { ...now, sessionId: randomUUID() }, sitter };
}

const MOST_TOPICS = 32;
export const TOPICS: string = `Name each topic once, as task:<id> or board, from one to ${String(MOST_TOPICS)}.`;

/** The board's stream (INB-1f) as one topic on the tab's stream: every frame it sends is labelled so. */
export const BOARD = 'board';

/** What a stream writes through and ends: the SSE stream, or one topic group's share of it. */
export type LiveStream = Pick<SSEStreamingApi, 'writeSSE' | 'abort' | 'aborted' | 'onAbort'>;

/** The topics a tab named, or undefined when any is malformed, repeated or too many. */
export function topicsOf(
  named: readonly string[],
): { readonly watches: readonly Watch[]; readonly board: boolean } | undefined {
  if (named.length === 0 || named.length > MOST_TOPICS) return undefined;
  if (new Set(named).size !== named.length) return undefined;
  const tasks = named.filter((label) => label !== BOARD);
  const watches = tasks.map((label) => ({ label, taskId: TOPIC.exec(label)?.[1] }));
  if (!watches.every((watch): watch is Watch => watch.taskId !== undefined)) return undefined;
  return { watches, board: tasks.length < named.length };
}

/**
 * The stream split between topic groups (the tasks and the board): each share
 * writes through it and ends alone, and the stream ends with its last share.
 * `label` names every frame a share writes, when one is given.
 */
export function sharesOf(
  stream: SSEStreamingApi,
  labels: readonly (string | undefined)[],
): LiveStream[] {
  let open = labels.length;
  return labels.map((label) => {
    const listeners: (() => void | Promise<void>)[] = [];
    let ended = false;
    const share: LiveStream = {
      get aborted() {
        return ended || stream.aborted;
      },
      writeSSE: async (message) => {
        if (share.aborted) return;
        await stream.writeSSE(label === undefined ? message : { ...message, data: label });
      },
      onAbort: (listener) => {
        listeners.push(listener);
      },
      abort: () => {
        if (ended) return;
        ended = true;
        for (const listener of listeners) void listener();
        open -= 1;
        if (open === 0) stream.abort();
      },
    };
    stream.onAbort(() => share.abort());
    return share;
  });
}

/**
 * Ends `stream` with its request. A tab that leaves while the route still
 * awaits its door closes the socket before the stream exists, and the stream
 * never hears of it; the request's signal does (FIX-2B1 RS B1).
 */
export function endsWithRequest(stream: Pick<LiveStream, 'abort'>, request: AbortSignal): void {
  if (request.aborted) stream.abort();
  else
    request.addEventListener(
      'abort',
      () => {
        stream.abort();
      },
      { once: true },
    );
}

export const RECHECK_MS = 30_000;
const noop = (): void => {};
const RANK = { check: 0, invalidate: 1, resync: 2 } as const;

/**
 * One open stream: `seat` when it is seated, `resync` for each watched task
 * once subscribed, then each signal once the caller is asked again, and
 * `closed` the first time the answer is no. An ended session answers no for
 * every task on the next check, and the stream ends with its last task.
 */
export async function follow(
  stream: LiveStream,
  live: { readonly topics: LiveTopics; readonly recheckMs?: number },
  watches: readonly Watch[],
  asks: Watching,
  seated?: Seated,
): Promise<void> {
  // A stream that ended before this ran (the tab left while the route awaited)
  // never calls a listener added now, so its end is taken as already here.
  const ended = new Promise<void>((resolve) => {
    if (stream.aborted) resolve();
    else stream.onAbort(resolve);
  });
  let finished = noop;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  // Closing the topics stops the stream and waits until no question it asked is in flight.
  const stop = async (): Promise<void> => {
    stream.abort();
    await done;
  };
  const follower = new Follower(stream, asks, seated);
  for (const watch of watches) follower.watch(watch, live.topics, stop);
  const timer = setInterval(() => follower.checkAll(), live.recheckMs ?? RECHECK_MS);
  try {
    if (seated !== undefined)
      await stream.writeSSE({ event: 'seat', data: seated.session.sessionId });
    for (const watch of watches) {
      // eslint-disable-next-line no-await-in-loop -- written in order.
      await stream.writeSSE({ event: 'resync', data: watch.label });
    }
    await ended;
  } finally {
    clearInterval(timer);
    await follower.settled();
    follower.stopAll();
    finished();
  }
}

/**
 * The deliveries of one stream, one at a time. Signals that arrive for a task
 * while one is pending merge into it, the strongest kept; a presence change
 * rides with it. Every delivery asks again first, and writes nothing. The
 * seat, under one id, holds on each task the person the bearer resolves to
 * once that task's recheck passed; a new person leaves every seat to recheck.
 */
class Follower {
  readonly #stops = new Map<Watch, () => void>();
  readonly #leaves = new Map<Watch, () => void>();
  readonly #pending = new Map<Watch, LiveSignal | 'check'>();
  readonly #presence = new Set<Watch>();
  readonly #stream: LiveStream;
  readonly #asks: Watching;
  readonly #seated: Seated | undefined;
  #sitter: Sitter | undefined;
  #chain = Promise.resolve();

  constructor(stream: LiveStream, asks: Watching, seated: Seated | undefined) {
    this.#stream = stream;
    this.#asks = asks;
    this.#seated = seated;
    this.#sitter = seated?.session;
  }

  watch(watch: Watch, topics: LiveTopics, stop: () => Promise<void>): void {
    const unsubscribe = topics.subscribe(
      this.#asks.businessId,
      watch.taskId,
      (signal) => {
        this.want(watch, signal);
      },
      // Each topic's own handle: a topic closed alone must not take the stream's stop with it.
      async () => await stop(),
    );
    this.#stops.set(watch, unsubscribe);
    this.#sit(watch);
  }

  checkAll(): void {
    for (const watch of this.#stops.keys()) this.want(watch, 'check');
  }

  /** Resolves once the delivery in flight, and its question, is done. */
  async settled(): Promise<void> {
    await this.#chain;
  }

  stopAll(): void {
    for (const watch of this.#stops.keys()) this.#end(watch);
  }

  want(watch: Watch, signal: LiveSignal | 'check'): void {
    const was = this.#pending.get(watch);
    this.#queue(watch);
    if (was === undefined || RANK[signal] > RANK[was]) this.#pending.set(watch, signal);
  }

  #sit(watch: Watch): void {
    if (this.#seated === undefined || this.#sitter === undefined) return;
    const session = { ...this.#sitter, sessionId: this.#seated.session.sessionId };
    const leave = this.#seated.presence.seat(this.#asks.businessId, watch.taskId, session, () => {
      this.#queue(watch);
      this.#presence.add(watch);
    });
    this.#leaves.set(watch, leave);
  }

  #end(watch: Watch): void {
    this.#stops.get(watch)?.();
    this.#leaves.get(watch)?.();
    this.#stops.delete(watch);
    this.#leaves.delete(watch);
  }

  /** `watch` passed its recheck: seated as before, or every seat left for a new person. */
  async #reseat(watch: Watch): Promise<void> {
    if (this.#seated === undefined) return;
    const now = await this.#seated.sitter();
    const was = this.#sitter;
    if (now?.personId === was?.personId && now?.name === was?.name && now?.side === was?.side) {
      if (!this.#leaves.has(watch)) this.#sit(watch);
      return;
    }
    for (const leave of this.#leaves.values()) leave();
    this.#leaves.clear();
    this.#sitter = now;
    this.checkAll();
  }

  #queue(watch: Watch): void {
    if (this.#pending.has(watch) || this.#presence.has(watch)) return;
    this.#chain = this.#chain
      .then(async () => await this.#send(watch))
      .catch(() => this.#stream.abort());
  }

  async #send(watch: Watch): Promise<void> {
    const signal = this.#pending.get(watch);
    this.#pending.delete(watch);
    const shown = this.#presence.delete(watch);
    if ((signal === undefined && !shown) || this.#stream.aborted) return;
    if (!this.#stops.has(watch)) return;
    if (typeof (await this.#asks.again(watch.taskId)) !== 'string') {
      await this.#close(watch);
      return;
    }
    await this.#reseat(watch);
    if (signal !== undefined && signal !== 'check') {
      await this.#stream.writeSSE({ event: signal, data: watch.label });
    }
    if (shown) await this.#stream.writeSSE({ event: 'presence', data: watch.label });
  }

  async #close(watch: Watch): Promise<void> {
    this.#end(watch);
    await this.#stream.writeSSE({ event: 'closed', data: watch.label });
    if (this.#stops.size === 0) this.#stream.abort();
  }
}
