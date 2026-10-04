// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { expect, it, vi } from 'vitest';
import { useRead } from '../../apps/web/src/data/use-read.ts';
import { createLiveHub, FLOOR_MS } from '../../apps/web/src/data/live.ts';
import { mount } from './mount.tsx';

// Sol F1-FIX1 criterion 1, retitled by what it proves; its body is Sol's.
it('the unanswered live-read floor survives a stalled online retry', async () => {
  vi.useFakeTimers();
  let reads = 0;
  const hub = createLiveHub(() => Promise.resolve(null), { visible: () => true });
  function Probe(): ReactElement {
    const { state } = useRead<{ topic: string }>({
      grantKey: 'alpha:person',
      deps: [],
      run: () => {
        reads += 1;
        if (reads === 1) return Promise.resolve({ unavailable: true, because: 'Offline' });
        if (reads === 2) return new Promise(() => {});
        return Promise.resolve({ ok: true, value: { topic: 'task:one' } });
      },
      live: { hub, topic: (value) => value.topic },
    });
    return <p>{state.outcome}</p>;
  }
  const view = await mount(<Probe />);
  try {
    expect(view.text()).toBe('unavailable');
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await Promise.resolve();
    });
    expect(reads).toBe(2);
    expect(view.text()).toBe('loading');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FLOOR_MS);
    });
    expect(
      view.text(),
      'C4 must reread on the 30-second floor even while the previous fetch stalls',
    ).toBe('ready');
  } finally {
    await view.unmount();
    vi.useRealTimers();
  }
});
