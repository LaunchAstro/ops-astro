// SPDX-License-Identifier: AGPL-3.0-only
//
// C4: the tab's one live stream (T2f's channel, every topic at once; a browser
// allows about six connections to an origin). Pages follow topics, counted by
// reference; whenever the set changes the stream is joined again naming all of
// them, and the server's `resync` covers the gap. An event re-reads a visible
// page through the checked read, as do a 30-second floor while the stream is
// refused or unreachable, becoming visible and coming back online (LIVE-SYNC.md,
// "The decision"). `closed`, a revocation, re-reads even a hidden page and
// leaves that topic off the stream until its last follower has gone.
// A page no topic reaches, an agency-wide rollup, follows `rollup-floor.ts`
// instead: every 30 s while visible, at once on return, no timer while hidden.
// C2 rides the same stream: `seat` hands the tab its seat in the presence
// book, and `presence` says who is on a topic changed; the page re-reads it
// through that seat (`presence.ts`). A stream joined again is a new seat, and
// one that is down is no seat.

export const FLOOR_MS = 30_000;
const REJOIN_MS = 2_000;
const EVENT = /^event: (invalidate|resync|closed|seat|presence)\ndata: (.*)$/mu;

export type LiveChange = 'changed' | 'closed';

type OnChange = (change: LiveChange) => void;
type OnSeat = (seat: string | null) => void;

/** Open one stream naming `topics`, or null when it is refused or unreachable. */
export type OpenTopics = (
  topics: readonly string[],
  signal: AbortSignal,
) => Promise<ReadableStream<Uint8Array> | null>;

export interface HubOptions {
  readonly visible?: () => boolean;
  readonly now?: () => number;
}

export interface LiveHub {
  /** Hear `topic` until the returned function is called. */
  follow(topic: string, onChange: OnChange): () => void;
  /** Hear `topic`'s presence (C2): each seat the stream is handed, and each change on the task. */
  presence(topic: string, onSeat: OnSeat): () => void;
  /** When the stream went down, or null while it is open or none is needed (`LiveStatus`). */
  readonly downSince: number | null;
  /** Hear `downSince` change until the returned function is called. */
  watch(onStatus: () => void): () => void;
}

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (name: string, topic: string) => void,
  signal: AbortSignal,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  signal.addEventListener('abort', () => void reader.cancel().catch(() => {}));
  let buffer = '';
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- a stream is read in order.
    const { value, done } = await reader.read();
    if (done) return;
    const blocks = (buffer + decoder.decode(value, { stream: true })).split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const [, name, topic] = EVENT.exec(block) ?? [];
      if (name !== undefined && topic !== undefined) onEvent(name, topic);
    }
  }
}

/** The tab's stream and the pages following it; each part a short method. */
class TabStream implements LiveHub {
  readonly #followers = new Map<string, Set<OnChange>>();
  readonly #closed = new Set<string>();
  readonly #seated = new Map<string, Set<OnSeat>>();
  readonly #watchers = new Set<() => void>();
  #seat: string | null = null;
  #joined: { readonly topics: string; readonly abort: AbortController } | null = null;
  #floor: ReturnType<typeof setInterval> | undefined;
  #downSince: number | null = null;

  readonly #open: OpenTopics;
  readonly #visible: () => boolean;
  readonly #now: () => number;

  constructor(open: OpenTopics, visible: () => boolean, now: () => number) {
    this.#open = open;
    this.#visible = visible;
    this.#now = now;
  }

  get downSince(): number | null {
    return this.#downSince;
  }

  watch(onStatus: () => void): () => void {
    this.#watchers.add(onStatus);
    return () => this.#watchers.delete(onStatus);
  }

  #status(downSince: number | null): void {
    if (this.#downSince === downSince) return;
    this.#downSince = downSince;
    for (const onStatus of this.#watchers) onStatus();
  }

  follow(topic: string, onChange: OnChange): () => void {
    if (this.#followers.size === 0) this.#listen(true);
    this.#followers.set(topic, (this.#followers.get(topic) ?? new Set()).add(onChange));
    // Joined once a render's follows and stops have all landed.
    queueMicrotask(this.#rejoin);
    return () => {
      const each = this.#followers.get(topic);
      each?.delete(onChange);
      if (each?.size === 0) {
        this.#followers.delete(topic);
        this.#closed.delete(topic);
      }
      queueMicrotask(this.#rejoin);
    };
  }

  presence(topic: string, onSeat: OnSeat): () => void {
    this.#seated.set(topic, (this.#seated.get(topic) ?? new Set()).add(onSeat));
    if (this.#seat !== null) onSeat(this.#seat);
    return () => {
      const each = this.#seated.get(topic);
      each?.delete(onSeat);
      if (each?.size === 0) this.#seated.delete(topic);
    };
  }

  /** A new seat, or none: every presence listener hears it. */
  #reseat(seat: string | null): void {
    if (this.#seat === seat) return;
    this.#seat = seat;
    for (const each of this.#seated.values()) for (const onSeat of each) onSeat(seat);
  }

  #tell(topic: string, change: LiveChange): void {
    for (const onChange of this.#followers.get(topic) ?? []) onChange(change);
  }

  readonly #refresh = (): void => {
    if (this.#visible()) for (const topic of this.#followers.keys()) this.#tell(topic, 'changed');
  };

  readonly #onEvent = (name: string, topic: string): void => {
    if (name === 'seat') {
      this.#reseat(topic);
      return;
    }
    if (name === 'presence') {
      const seat = this.#seat;
      if (seat !== null) for (const onSeat of this.#seated.get(topic) ?? []) onSeat(seat);
      return;
    }
    if (name !== 'closed') {
      if (this.#visible()) this.#tell(topic, 'changed');
      return;
    }
    this.#closed.add(topic);
    this.#tell(topic, 'closed');
  };

  #listen(on: boolean): void {
    const method = on ? 'addEventListener' : 'removeEventListener';
    document[method]('visibilitychange', this.#refresh);
    window[method]('online', this.#refresh);
  }

  #up(): void {
    clearInterval(this.#floor);
    this.#floor = undefined;
    this.#status(null);
  }

  #down(refused: boolean): void {
    this.#status(this.#downSince ?? this.#now());
    if (refused) this.#floor ??= setInterval(this.#refresh, FLOOR_MS);
  }

  #wanted(): string[] {
    return [...this.#followers.keys()].filter((topic) => !this.#closed.has(topic)).toSorted();
  }

  readonly #rejoin = (): void => {
    const topics = this.#wanted().join(' ');
    if (this.#joined?.topics === topics) return;
    this.#joined?.abort.abort();
    this.#joined = null;
    this.#reseat(null);
    if (this.#followers.size === 0) {
      this.#up();
      this.#listen(false);
      return;
    }
    const abort = new AbortController();
    this.#joined = { topics, abort };
    void this.#run(abort);
  };

  async #run(abort: AbortController): Promise<void> {
    const topics = this.#wanted();
    const body =
      topics.length === 0 ? null : await this.#open(topics, abort.signal).catch(() => null);
    if (abort.signal.aborted) return;
    if (body === null) this.#down(true);
    else {
      this.#up();
      await readEvents(body, this.#onEvent, abort.signal).catch(() => {});
      if (abort.signal.aborted) return;
      this.#reseat(null);
      this.#down(false);
    }
    await wait(body === null ? FLOOR_MS : REJOIN_MS, abort.signal);
    if (!abort.signal.aborted) await this.#run(abort);
  }
}

export function createLiveHub(
  open: OpenTopics,
  { visible = () => document.visibilityState === 'visible', now = Date.now }: HubOptions = {},
): LiveHub {
  return new TabStream(open, visible, now);
}

const hubs = new WeakMap<object, LiveHub>();

/** The tab's one hub for a client: every page drawn through it shares the stream. */
export function hubOf(client: { openLive: OpenTopics }): LiveHub {
  const hub =
    hubs.get(client) ??
    createLiveHub(async (topics, signal) => await client.openLive(topics, signal));
  hubs.set(client, hub);
  return hub;
}
