// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A live read whose first answer is unavailable has no topic to follow yet. It
// re-reads on coming online and on the floor, and those re-reads are recovery,
// not live changes: `live` stays false while they load (#747), so a host never
// keeps an answer drawn through one. Once a re-read answers, the read follows
// its topic on the hub, so it hears the next change (#468).

import { act, type ReactElement } from 'react';
import { expect, it, vi } from 'vitest';
import { useRead } from '../../apps/web/src/data/use-read.ts';
import { createLiveHub, FLOOR_MS } from '../../apps/web/src/data/live.ts';
import type { CallResult } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

function world() {
  let online = false;
  let answer: ((result: CallResult<{ topic: string }>) => void) | null = null;
  const hub = createLiveHub(() => Promise.resolve(null), { visible: () => true });
  const followed: string[] = [];
  const follow = hub.follow.bind(hub);
  vi.spyOn(hub, 'follow').mockImplementation((topic, onChange) => {
    followed.push(topic);
    return follow(topic, onChange);
  });
  // Each frame: what it drew, and whether `useRead` called the read in flight live.
  const frames: { outcome: string; live: boolean }[] = [];
  function Probe(): ReactElement {
    const { state, live } = useRead<{ topic: string }>({
      grantKey: 'alpha:ada:0',
      deps: [],
      run: () =>
        online
          ? new Promise((resolve) => {
              answer = resolve;
            })
          : Promise.resolve({ unavailable: true, because: 'Offline' }),
      live: { hub, topic: (value) => value.topic },
    });
    frames.push({ outcome: state.outcome, live });
    return <p>{state.outcome}</p>;
  }
  return {
    Probe,
    frames,
    followed,
    goOnline: () => {
      online = true;
    },
    answer: (result: CallResult<{ topic: string }>) => answer?.(result),
  };
}

it('an online retry of an unanswered live read is not live, and its answer is then followed', async () => {
  const at = world();
  const view = await mount(<at.Probe />);
  try {
    expect(view.text()).toBe('unavailable');
    expect(at.followed).toEqual([]);
    at.goOnline();
    const before = at.frames.length;
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await Promise.resolve();
    });
    expect(view.text()).toBe('loading');
    const retrying = at.frames.slice(before).filter((frame) => frame.outcome === 'loading');
    expect(retrying.length).toBeGreaterThan(0);
    expect(
      retrying.map((frame) => frame.live),
      'an online retry was drawn as live',
    ).not.toContain(true);
    await act(async () => {
      at.answer({ ok: true, value: { topic: 'task:one' } });
      await Promise.resolve();
    });
    expect(view.text()).toBe('ready');
    expect(at.followed, 'the recovered read never subscribed to its topic').toContain('task:one');
  } finally {
    await view.unmount();
  }
});

it('a floor retry of an unanswered live read is not live', async () => {
  vi.useFakeTimers();
  const at = world();
  const view = await mount(<at.Probe />);
  try {
    expect(view.text()).toBe('unavailable');
    at.goOnline();
    const before = at.frames.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FLOOR_MS);
    });
    expect(view.text()).toBe('loading');
    const retrying = at.frames.slice(before).filter((frame) => frame.outcome === 'loading');
    expect(retrying.length).toBeGreaterThan(0);
    expect(
      retrying.map((frame) => frame.live),
      'a floor retry was drawn as live',
    ).not.toContain(true);
  } finally {
    await view.unmount();
    vi.useRealTimers();
  }
});
