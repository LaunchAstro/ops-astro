// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { expect, it, vi } from 'vitest';
import { useRead } from '../../apps/web/src/data/use-read.ts';
import { createLiveHub, FLOOR_MS } from '../../apps/web/src/data/live.ts';
import { mount } from './mount.tsx';

/** Sol's case, its assertions unchanged, with one trigger fired where it fired all three. */
async function recovers(trigger: string, fire: () => unknown): Promise<void> {
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
      await fire();
    });
    expect(view.text(), `${trigger} alone must recover the first read`).toBe('ready');
  } finally {
    await view.unmount();
  }
}

// Sol OW-080.2 criterion 1, retitled by what it proves; its body is Sol's. Sol F1-FIX1 criterion 7
// split its three triggers, so each recovers the read alone. One case, so the faithfulness proof
// (online-recovery-proof-rejects-removed-listener) counts it as the one test it names.
it('an initially unavailable live read recovers on coming online, on being shown and on the floor, each alone', async () => {
  vi.useFakeTimers();
  try {
    await recovers('online', () => window.dispatchEvent(new Event('online')));
    await recovers('visibility', () => document.dispatchEvent(new Event('visibilitychange')));
    await recovers('the 30-second floor', () => vi.advanceTimersByTimeAsync(FLOOR_MS));
  } finally {
    vi.useRealTimers();
  }
});
