// SPDX-License-Identifier: AGPL-3.0-only
//
// T2f: the page's side of the live task channel. An event re-reads a visible
// page through the checked read, as do a 30-second floor while the stream is
// down, becoming visible and coming back online (LIVE-SYNC.md, "The
// decision"). `closed`, a revocation, re-reads even a hidden page. An ended
// stream is joined again; the server's `resync` covers the gap.

export const FLOOR_MS = 30_000;
const REJOIN_MS = 2_000;
const EVENT = /^event: (invalidate|resync|closed|inbox)$/mu;

/** `inbox`: the caller's own inbox changed (INB-1f's board stream only). */
export type LiveChange = 'changed' | 'closed' | 'inbox';

export interface FollowOptions {
  readonly visible?: () => boolean;
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
  onEvent: (name: string) => void,
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
    for (const name of blocks.map((block) => EVENT.exec(block)?.[1])) if (name) onEvent(name);
  }
}

/** Follow one task's stream until the returned function is called. */
export function followLive(
  open: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array> | null>,
  onChange: (change: LiveChange) => void,
  { visible = () => document.visibilityState === 'visible' }: FollowOptions = {},
): () => void {
  const abort = new AbortController();
  const refresh = (): void => {
    if (visible()) onChange('changed');
  };
  const onEvent = (name: string): void => {
    if (name === 'closed') onChange('closed');
    else if (name === 'inbox' && visible()) onChange('inbox');
    else refresh();
  };
  let floor: ReturnType<typeof setInterval> | undefined;
  const run = async (): Promise<void> => {
    const body = await open(abort.signal).catch(() => null);
    if (body === null) floor ??= setInterval(refresh, FLOOR_MS);
    else {
      clearInterval(floor);
      floor = undefined;
      await readEvents(body, onEvent, abort.signal).catch(() => {});
    }
    await wait(body === null ? FLOOR_MS : REJOIN_MS, abort.signal);
    if (!abort.signal.aborted) await run();
  };
  void run();
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('online', refresh);
  return () => {
    abort.abort();
    clearInterval(floor);
    document.removeEventListener('visibilitychange', refresh);
    window.removeEventListener('online', refresh);
  };
}
