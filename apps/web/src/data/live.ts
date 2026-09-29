// SPDX-License-Identifier: AGPL-3.0-only
//
// T2f: the page's side of the live task channel.
//
// The stream says only that the task changed, and the page re-reads through
// the ordinary checked read. While the stream is down, a 30-second floor
// re-reads a visible page, and a page re-reads when it becomes visible again
// or comes back online (`docs/design-system/research/LIVE-SYNC.md`, "The
// decision"). A hidden page re-reads nothing. A stream that ended is joined
// again after a moment; the server's `resync` on join covers the gap.

export const FLOOR_MS = 30_000;
const REJOIN_MS = 2_000;
const CHANGED = /^event: (?:invalidate|resync|closed)$/mu;

export interface FollowOptions {
  readonly visible?: () => boolean;
}

const pageVisible = (): boolean =>
  typeof document === 'undefined' || document.visibilityState === 'visible';

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

/** Call `onChange` for each event that says the task changed, until the stream ends. */
async function readEvents(
  body: ReadableStream<Uint8Array>,
  onChange: () => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  signal.addEventListener('abort', () => void reader.cancel().catch(() => {}));
  let buffer = '';
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- a stream is read in order.
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    if (blocks.some((block) => CHANGED.test(block))) onChange();
  }
}

/** Follow one task's stream until the returned function is called. */
export function followLive(
  open: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array> | null>,
  onChange: () => void,
  options: FollowOptions = {},
): () => void {
  const visible = options.visible ?? pageVisible;
  const abort = new AbortController();
  const refresh = (): void => {
    if (visible()) onChange();
  };
  let floor: ReturnType<typeof setInterval> | undefined;

  const run = async (): Promise<void> => {
    const body = await open(abort.signal).catch(() => null);
    if (body === null) {
      floor ??= setInterval(refresh, FLOOR_MS);
      await wait(FLOOR_MS, abort.signal);
    } else {
      clearInterval(floor);
      floor = undefined;
      await readEvents(body, onChange, abort.signal).catch(() => {});
      await wait(REJOIN_MS, abort.signal);
    }
    if (!abort.signal.aborted) await run();
  };
  void run();

  const hasWindow = typeof window !== 'undefined';
  if (hasWindow) {
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', refresh);
  }
  return () => {
    abort.abort();
    clearInterval(floor);
    if (hasWindow) {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('online', refresh);
    }
  };
}
