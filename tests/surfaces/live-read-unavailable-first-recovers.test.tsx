// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { expect, it, vi } from 'vitest';
import { useRead } from '../../apps/web/src/data/use-read.ts';
import { createLiveHub, FLOOR_MS } from '../../apps/web/src/data/live.ts';
import { mount } from './mount.tsx';

// Sol OW-080.2 criterion 1, retitled by what it proves; its body is Sol's.
it('an initially unavailable live read recovers when the browser comes online', async () => {
  vi.useFakeTimers();
  let online = false;
  let reads = 0;
  const hub = createLiveHub(() => Promise.resolve(null), { visible: () => true });
  function Probe(): ReactElement {
    const { state } = useRead<{ topic: string }>({
      grantKey: 'alpha:person',
      deps: [],
      run: async () => {
        reads += 1;
        return await Promise.resolve(
          online
            ? { ok: true, value: { topic: 'task:one' } }
            : { unavailable: true, because: 'Offline' },
        );
      },
      live: { hub, topic: (value) => value.topic },
    });
    return <p>{state.outcome}</p>;
  }
  const view = await mount(<Probe />);
  try {
    expect(view.text()).toBe('unavailable');
    expect(reads).toBe(1);
    online = true;
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(FLOOR_MS);
    });
    expect(
      view.text(),
      'online, visibility and the 30-second floor must recover the first read',
    ).toBe('ready');
  } finally {
    await view.unmount();
    vi.useRealTimers();
  }
});
