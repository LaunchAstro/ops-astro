// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A visible page keeps its 30-second checked reread while any join is in
// flight and no stream is open: a join that replaces an open stream when the
// followed topics change, and the tab's very first join, may never answer.
// The floor stops once a join opens and when the last page stops following.

import { afterEach, expect, it, vi } from 'vitest';
import { createLiveHub, FLOOR_MS, type LiveChange } from '../../apps/web/src/data/live.ts';

afterEach(() => {
  vi.useRealTimers();
});

const openStream = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>();

it('a join that replaces an open stream when the topics change, and stalls, still rereads a visible page on the floor', async () => {
  vi.useFakeTimers();
  let opens = 0;
  const open = async (): Promise<ReadableStream<Uint8Array>> => {
    opens += 1;
    if (opens > 1) return await new Promise<never>(() => {});
    return await Promise.resolve(openStream());
  };
  const hub = createLiveHub(open, { visible: () => true });
  const heard: LiveChange[] = [];
  const stopA = hub.follow('task:a', (change) => heard.push(change));
  let stopB: (() => void) | undefined;
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(opens).toBe(1);

    stopB = hub.follow('task:b', (change) => heard.push(change));
    await vi.advanceTimersByTimeAsync(2 * FLOOR_MS);
    expect(opens, 'the join naming both topics was asked for and is still pending').toBe(2);
    expect(heard, 'both pages are reread on the floor while the join stalls').toEqual([
      'changed',
      'changed',
      'changed',
      'changed',
    ]);
  } finally {
    stopA();
    stopB?.();
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(vi.getTimerCount(), 'no floor is left once no page follows').toBe(0);
});

it("the tab's first join, when it stalls, still rereads a visible page on the floor until it opens", async () => {
  vi.useFakeTimers();
  let answer: ((body: ReadableStream<Uint8Array>) => void) | undefined;
  let opens = 0;
  const open = async (): Promise<ReadableStream<Uint8Array>> => {
    opens += 1;
    return await new Promise((resolve) => {
      answer = resolve;
    });
  };
  const hub = createLiveHub(open, { visible: () => true });
  const heard: LiveChange[] = [];
  const stop = hub.follow('task:a', (change) => heard.push(change));
  try {
    await vi.advanceTimersByTimeAsync(2 * FLOOR_MS);
    expect(opens, 'the first join was asked for and is still pending').toBe(1);
    expect(heard, 'the page is reread on the floor while the first join stalls').toEqual([
      'changed',
      'changed',
    ]);

    answer?.(openStream());
    await vi.advanceTimersByTimeAsync(2 * FLOOR_MS);
    expect(heard, 'no floor reread once the join opened').toHaveLength(2);
    expect(hub.downSince).toBeNull();
  } finally {
    stop();
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(vi.getTimerCount(), 'no floor is left once no page follows').toBe(0);
});
