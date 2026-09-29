// SPDX-License-Identifier: AGPL-3.0-only
//
// C4's one stream per tab, from join to end, and C2's presence on it: the
// topics a tab names, and the loop that re-asks before every delivery. Moved
// out of app.ts unchanged in what it sends, with presence added.

import type { SSEStreamingApi } from 'hono/streaming';
import type { CommandRefusal } from '../../packages/core-commands/src/index.ts';
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

/** A stream's seat in the presence book (C2): its id is handed to the tab alone. */
export interface Seated {
  readonly session: PresenceSession;
  readonly presence: LivePresence;
}

const MOST_TOPICS = 32;
export const TOPICS: string = `Name each topic once, as task:<id>, from one to ${String(MOST_TOPICS)}.`;

/** The topics a tab named, or undefined when any is malformed, repeated or too many. */
export function topicsOf(named: readonly string[]): readonly Watch[] | undefined {
  if (named.length === 0 || named.length > MOST_TOPICS) return undefined;
  if (new Set(named).size !== named.length) return undefined;
  const watches = named.map((label) => ({ label, taskId: TOPIC.exec(label)?.[1] }));
  return watches.every((watch): watch is Watch => watch.taskId !== undefined) ? watches : undefined;
}

const RECHECK_MS = 30_000;
const RANK = { check: 0, invalidate: 1, resync: 2 } as const;

/**
 * One open stream: `seat` when it is seated, `resync` for each watched task
 * once subscribed, then each signal once the caller is asked again, and
 * `closed` the first time the answer is no. An ended session answers no for
 * every task on the next check, and the stream ends with its last task.
 */
export async function follow(
  stream: SSEStreamingApi,
  live: { readonly topics: LiveTopics; readonly recheckMs?: number },
  watches: readonly Watch[],
  asks: Watching,
  seated?: Seated,
): Promise<void> {
  const ended = new Promise<void>((resolve) => {
    stream.onAbort(resolve);
  });
  const follower = new Follower(stream, asks);
  for (const watch of watches) follower.watch(watch, live.topics, seated);
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
    follower.stopAll();
  }
}

/**
 * The deliveries of one stream, one at a time. Signals that arrive for a task
 * while one is pending merge into it, the strongest kept; a presence change
 * rides with it. Every delivery asks again first, and writes nothing.
 */
class Follower {
  readonly #stops = new Map<Watch, () => void>();
  readonly #pending = new Map<Watch, LiveSignal | 'check'>();
  readonly #presence = new Set<Watch>();
  readonly #stream: SSEStreamingApi;
  readonly #asks: Watching;
  #chain = Promise.resolve();

  constructor(stream: SSEStreamingApi, asks: Watching) {
    this.#stream = stream;
    this.#asks = asks;
  }

  watch(watch: Watch, topics: LiveTopics, seated: Seated | undefined): void {
    const { businessId } = this.#asks;
    const unsubscribe = topics.subscribe(businessId, watch.taskId, (signal) => {
      this.want(watch, signal);
    });
    const leave = seated?.presence.seat(businessId, watch.taskId, seated.session, () => {
      this.#queue(watch);
      this.#presence.add(watch);
    });
    this.#stops.set(watch, () => {
      unsubscribe();
      leave?.();
    });
  }

  checkAll(): void {
    for (const watch of this.#stops.keys()) this.want(watch, 'check');
  }

  stopAll(): void {
    for (const stop of this.#stops.values()) stop();
  }

  want(watch: Watch, signal: LiveSignal | 'check'): void {
    const was = this.#pending.get(watch);
    this.#queue(watch);
    if (was === undefined || RANK[signal] > RANK[was]) this.#pending.set(watch, signal);
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
    if (signal !== undefined && signal !== 'check') {
      await this.#stream.writeSSE({ event: signal, data: watch.label });
    }
    if (shown) await this.#stream.writeSSE({ event: 'presence', data: watch.label });
  }

  async #close(watch: Watch): Promise<void> {
    this.#stops.get(watch)?.();
    this.#stops.delete(watch);
    await this.#stream.writeSSE({ event: 'closed', data: watch.label });
    if (this.#stops.size === 0) this.#stream.abort();
  }
}
