// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A live read belongs to its business and its person (#397). A switch with the
// same record dependencies starts a new read: the last owner's answer neither
// holds back the new owner's recovery nor reaches the new owner's screen, not
// even for one frame. The first case is the review's proof (F1-FIX3.1), moved
// unchanged into a file named by behaviour.

import { act, type ReactElement } from 'react';
import { expect, it, vi } from 'vitest';
import { useRead } from '../../apps/web/src/data/use-read.ts';
import { createLiveHub, FLOOR_MS, type LiveHub } from '../../apps/web/src/data/live.ts';
import { mount } from './mount.tsx';

const hub = () =>
  createLiveHub(() => Promise.resolve(new ReadableStream<Uint8Array>()), {
    visible: () => true,
  });

it.each([
  ['business to business', 'bravo:ada'],
  ['person to person', 'alpha:ben'],
])('a %s change recovers an unanswered live read on the floor', async (_boundary, nextGrant) => {
  vi.useFakeTimers();
  const firstHub = hub();
  const nextHub = hub();
  let available = false;
  let reads = 0;
  function Probe(props: { readonly grant: string; readonly live: LiveHub }): ReactElement {
    const { state } = useRead<{ topic: string }>({
      grantKey: props.grant,
      deps: ['T-1'],
      run: () => {
        reads += 1;
        return Promise.resolve(
          props.grant === 'alpha:ada' || available
            ? { ok: true, value: { topic: `task:${props.grant}` } }
            : { unavailable: true, because: 'Offline' },
        );
      },
      live: { hub: props.live, topic: (value) => value.topic },
    });
    return <p>{state.outcome}</p>;
  }
  const view = await mount(<Probe grant="alpha:ada" live={firstHub} />);
  try {
    expect(view.text()).toBe('ready');
    await view.render(<Probe grant={nextGrant} live={nextHub} />);
    expect(view.text()).toBe('unavailable');
    expect(reads).toBe(2);
    available = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FLOOR_MS);
    });
    expect({ state: view.text(), reads }).toEqual({ state: 'ready', reads: 3 });
  } finally {
    await view.unmount();
    vi.useRealTimers();
  }
});

it.each([
  ['business to business', 'bravo:ada'],
  ['person to person', 'alpha:ben'],
])(
  'a %s change never draws the previous owner’s rows, not for one frame',
  async (_boundary, nextGrant) => {
    // Every frame the probe commits, with the grant it was drawn for.
    const frames: { grant: string; outcome: string; rows: string | null }[] = [];
    let answerNext!: (rows: string) => void;
    function Probe(props: { readonly grant: string }): ReactElement {
      const { state } = useRead<{ rows: string }>({
        grantKey: props.grant,
        deps: ['T-1'],
        run: () =>
          props.grant === 'alpha:ada'
            ? Promise.resolve({ ok: true, value: { rows: 'alpha-ada-rows' } })
            : new Promise((resolve) => {
                answerNext = (rows) => {
                  resolve({ ok: true, value: { rows } });
                };
              }),
      });
      const rows =
        state.outcome === 'ready'
          ? state.value.rows
          : state.outcome === 'loading'
            ? (state.previous?.rows ?? null)
            : null;
      frames.push({ grant: props.grant, outcome: state.outcome, rows });
      return <p>{rows ?? state.outcome}</p>;
    }
    const view = await mount(<Probe grant="alpha:ada" />);
    try {
      expect(view.text()).toBe('alpha-ada-rows');
      await view.render(<Probe grant={nextGrant} />);
      await act(async () => {
        answerNext('next-owner-rows');
        await Promise.resolve();
      });
      expect(view.text()).toBe('next-owner-rows');
      const leaked = frames.filter(
        (frame) => frame.grant === nextGrant && frame.rows === 'alpha-ada-rows',
      );
      expect(leaked, 'a frame drawn for the new owner held the previous owner’s rows').toEqual([]);
    } finally {
      await view.unmount();
    }
  },
);
