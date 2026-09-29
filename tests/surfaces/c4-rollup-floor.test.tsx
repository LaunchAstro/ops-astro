// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C4 on an agency-wide rollup: no topic reaches it (LIVE-SYNC.md, "two topic
// shapes and no third"), so it re-reads on the floor: every 30 s while the tab
// is visible, at once when it becomes visible again or comes back online, and
// not at all while hidden, when the tab runs no timer for it.

import { act, type ReactElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useRead } from '../../apps/web/src/data/use-read.ts';
import { createRollupFloor, FLOOR_MS, type RollupFloor } from '../../apps/web/src/data/live.ts';
import type { CallResult } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

afterEach(() => {
  vi.useRealTimers();
});

let visible = true;
const floorFor = (): RollupFloor => createRollupFloor({ visible: () => visible });

async function turn(to: boolean): Promise<void> {
  visible = to;
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function pass(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** A rollup page: one read, no topic, on the floor. */
function rollupPage(floor: RollupFloor, reads: { n: number }) {
  return function Rollup(): ReactElement {
    const { state } = useRead<{ total: number }>({
      grantKey: 'viewer',
      run: async (): Promise<CallResult<{ total: number }>> => {
        reads.n += 1;
        return await Promise.resolve({ ok: true, value: { total: reads.n } });
      },
      deps: [],
      rollup: floor,
    });
    return <p>{state.outcome}</p>;
  };
}

it('C4 live-sync 7: a rollup page with no topic refreshes within 30 s while visible and not at all while hidden', async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  visible = true;
  const reads = { n: 0 };
  const Rollup = rollupPage(floorFor(), reads);
  const screen = await mount(<Rollup />);
  expect(reads.n).toBe(1);

  await pass(FLOOR_MS);
  expect(reads.n).toBe(2);
  await pass(FLOOR_MS);
  expect(reads.n).toBe(3);

  await turn(false);
  await pass(FLOOR_MS * 4);
  expect(reads.n).toBe(3);
  expect(vi.getTimerCount()).toBe(0);

  await turn(true);
  expect(reads.n).toBe(4);
  await pass(FLOOR_MS - 1);
  expect(reads.n).toBe(4);
  await pass(1);
  expect(reads.n).toBe(5);

  await act(async () => {
    window.dispatchEvent(new Event('online'));
  });
  expect(reads.n).toBe(6);

  await screen.unmount();
  await pass(FLOOR_MS * 2);
  expect(reads.n).toBe(6);
  expect(vi.getTimerCount()).toBe(0);
});

it('C4 live-sync 7 (floor): rollup pages share one timer, each re-read once a tick, and the last to leave stops it', async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  visible = true;
  const floor = floorFor();
  const heard = { a: 0, b: 0 };
  const stopA = floor.follow(() => (heard.a += 1));
  const stopB = floor.follow(() => (heard.b += 1));
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(FLOOR_MS);
  expect(heard).toEqual({ a: 1, b: 1 });

  stopA();
  await vi.advanceTimersByTimeAsync(FLOOR_MS);
  expect(heard).toEqual({ a: 1, b: 2 });
  stopB();
  expect(vi.getTimerCount()).toBe(0);
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('online'));
  expect(heard).toEqual({ a: 1, b: 2 });
});
