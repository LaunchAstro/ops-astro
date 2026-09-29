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

export const FLOOR_MS = 30_000;
const REJOIN_MS = 2_000;
const EVENT = /^event: (invalidate|resync|closed)\ndata: (.*)$/mu;

export type LiveChange = 'changed' | 'closed';

type OnChange = (change: LiveChange) => void;

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
  /** When the stream went down, or null while it is open or none is needed (`LiveStatus`). */
  readonly downSince: number | null;
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

export function createLiveHub(
  open: OpenTopics,
  { visible = () => document.visibilityState === 'visible', now = Date.now }: HubOptions = {},
): LiveHub {
  const followers = new Map<string, Set<OnChange>>();
  const closed = new Set<string>();
  let joined: { readonly topics: string; readonly abort: AbortController } | null = null;
  let floor: ReturnType<typeof setInterval> | undefined;
  let downSince: number | null = null;

  const tell = (topic: string, change: LiveChange): void => {
    for (const onChange of followers.get(topic) ?? []) onChange(change);
  };
  const refresh = (): void => {
    if (visible()) for (const topic of followers.keys()) tell(topic, 'changed');
  };
  const onEvent = (name: string, topic: string): void => {
    if (name !== 'closed') {
      if (visible()) tell(topic, 'changed');
      return;
    }
    closed.add(topic);
    tell(topic, 'closed');
  };
  const up = (): void => {
    clearInterval(floor);
    floor = undefined;
    downSince = null;
  };
  const down = (refused: boolean): void => {
    downSince ??= now();
    if (refused) floor ??= setInterval(refresh, FLOOR_MS);
  };
  const wanted = (): string[] => [...followers.keys()].filter((t) => !closed.has(t)).toSorted();

  const run = async (abort: AbortController): Promise<void> => {
    const topics = wanted();
    const body = topics.length === 0 ? null : await open(topics, abort.signal).catch(() => null);
    if (abort.signal.aborted) return;
    if (body === null) down(true);
    else {
      up();
      await readEvents(body, onEvent, abort.signal).catch(() => {});
      if (abort.signal.aborted) return;
      down(false);
    }
    await wait(body === null ? FLOOR_MS : REJOIN_MS, abort.signal);
    if (!abort.signal.aborted) await run(abort);
  };

  const rejoin = (): void => {
    const topics = wanted().join(' ');
    if (joined?.topics === topics) return;
    joined?.abort.abort();
    joined = null;
    if (followers.size === 0) {
      up();
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('online', refresh);
      return;
    }
    const abort = new AbortController();
    joined = { topics, abort };
    void run(abort);
  };

  return {
    follow(topic, onChange) {
      if (followers.size === 0) {
        document.addEventListener('visibilitychange', refresh);
        window.addEventListener('online', refresh);
      }
      followers.set(topic, (followers.get(topic) ?? new Set()).add(onChange));
      // Joined once a render's follows and stops have all landed.
      queueMicrotask(rejoin);
      return () => {
        const each = followers.get(topic);
        each?.delete(onChange);
        if (each?.size === 0) {
          followers.delete(topic);
          closed.delete(topic);
        }
        queueMicrotask(rejoin);
      };
    },
    get downSince() {
      return downSince;
    },
  };
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
