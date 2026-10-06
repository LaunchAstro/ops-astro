// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { expect, it, vi } from 'vitest';
import { useRead } from '../../apps/web/src/data/use-read.ts';
import { createLiveHub, FLOOR_MS } from '../../apps/web/src/data/live.ts';
import { mount } from './mount.tsx';

// Sol F2-FIX2 correctness, retitled by what it proves; its body is Sol's.
it('an unavailable new record recovers on the floor after a previous live record', async () => {
  vi.useFakeTimers();
  const joined: string[][] = [];
  const hub = createLiveHub(
    (topics) => {
      joined.push([...topics]);
      return Promise.resolve(new ReadableStream<Uint8Array>());
    },
    { visible: () => true },
  );
  let reads = 0;
  let available = false;
  function Probe({ record }: { readonly record: string }): ReactElement {
    const { state } = useRead<{ topic: string }>({
      grantKey: 'alpha:ada',
      deps: [record],
      run: () => {
        reads += 1;
        return Promise.resolve(
          record === 'first' || available
            ? { ok: true, value: { topic: `task:${record}` } }
            : { unavailable: true, because: 'Offline' },
        );
      },
      live: { hub, topic: (value) => value.topic },
    });
    return <p>{state.outcome}</p>;
  }
  const view = await mount(<Probe record="first" />);
  try {
    expect(view.text()).toBe('ready');
    expect(joined).toContainEqual(['task:first']);
    await view.render(<Probe record="second" />);
    expect(view.text()).toBe('unavailable');
    expect(reads).toBe(2);
    available = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FLOOR_MS);
    });
    expect(
      { state: view.text(), reads },
      'the first record topic must not suppress recovery of the second',
    ).toEqual({ state: 'ready', reads: 3 });
  } finally {
    await view.unmount();
    vi.useRealTimers();
  }
});
