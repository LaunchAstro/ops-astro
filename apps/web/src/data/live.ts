// SPDX-License-Identifier: AGPL-3.0-only
//
// T2f: the page's side of the live task channel. The stream says only that
// the task changed, and the page re-reads through the ordinary checked read.
// While it is down, a 30-second floor re-reads a visible page, as does the page
// becoming visible or coming back online; a hidden page re-reads nothing
// (`docs/design-system/research/LIVE-SYNC.md`, "The decision"). A stream that
// ended is joined again, and the server's `resync` on join covers the gap.

export const FLOOR_MS = 30_000;
const REJOIN_MS = 2_000;
const CHANGED = /^event: (?:invalidate|resync|closed)$/mu;

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
  onChange: () => void,
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
    if (blocks.some((block) => CHANGED.test(block))) onChange();
  }
}

/** Follow one task's stream until the returned function is called. */
export function followLive(
  open: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array> | null>,
  onChange: () => void,
  { visible = () => document.visibilityState === 'visible' }: FollowOptions = {},
): () => void {
  const abort = new AbortController();
  const refresh = (): void => {
    if (visible()) onChange();
  };
  let floor: ReturnType<typeof setInterval> | undefined;
  const run = async (): Promise<void> => {
    const body = await open(abort.signal).catch(() => null);
    if (body === null) floor ??= setInterval(refresh, FLOOR_MS);
    else {
      clearInterval(floor);
      floor = undefined;
      await readEvents(body, onChange, abort.signal).catch(() => {});
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
