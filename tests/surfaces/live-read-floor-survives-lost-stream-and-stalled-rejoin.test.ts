// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A visible page keeps its 30-second checked reread when the open stream ends
// and the join that should replace it never answers: the stream that was up
// had cleared the floor, and a stalled join must not leave the page unread.

import { afterEach, expect, it, vi } from 'vitest';
import { createLiveHub, FLOOR_MS, type LiveChange } from '../../apps/web/src/data/live.ts';

afterEach(() => {
  vi.useRealTimers();
});

it('a lost stream whose rejoin stalls still rereads a visible page on the 30-second floor', async () => {
  vi.useFakeTimers();
  let end: (() => void) | undefined;
  let opens = 0;
  const open = async (): Promise<ReadableStream<Uint8Array>> => {
    opens += 1;
    if (opens > 1) return await new Promise<never>(() => {});
    return await Promise.resolve(
      new ReadableStream<Uint8Array>({
        start(controller) {
          end = () => controller.close();
        },
      }),
    );
  };
  const hub = createLiveHub(open, { visible: () => true });
  const heard: LiveChange[] = [];
  const stop = hub.follow('task:a', (change) => heard.push(change));
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(opens).toBe(1);
    expect(hub.downSince).toBeNull();

    end?.();
    await vi.advanceTimersByTimeAsync(2 * FLOOR_MS);
    expect(opens, 'the replacement join was asked for and is still pending').toBe(2);
    expect(heard, 'the page is reread on the floor while the rejoin stalls').toEqual([
      'changed',
      'changed',
    ]);
  } finally {
    stop();
  }
});
