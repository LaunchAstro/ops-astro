// SPDX-License-Identifier: AGPL-3.0-only
//
// An answer the screen cannot read: its emptiness test throws.
//
// `useRead` offers the answer to its projection from a fire-and-forget async
// step, so a throw there used to escape as an unhandled rejection and leave the
// screen loading. S0-6C's session race met it on batch 1: its stub answers the
// inbox read with `{ ok: true }`, and the inbox's emptiness test reads a list
// that is not there. The read now shows as unavailable, and nothing escapes.

// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { useRead } from '../../apps/web/src/data/use-read.ts';
import { mount } from './mount.tsx';

interface Inbox {
  readonly inbox: readonly string[];
}

/** A read of an inbox whose answer has no list in it. */
function Probe(): ReactElement {
  const { state } = useRead<Inbox>({
    grantKey: 'grant',
    run: () => Promise.resolve({ ok: true, value: {} as Inbox }),
    isEmpty: (value) => value.inbox.length === 0,
    deps: [],
  });
  return <p>{state.outcome}</p>;
}

describe('useRead with an answer it cannot read', () => {
  it('shows the read as unavailable and lets no rejection escape', async () => {
    const escaped: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      escaped.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const screen = await mount(<Probe />);
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
      });

      expect(escaped.map(String), 'an unhandled rejection escaped useRead').toEqual([]);
      expect(screen.text()).toBe('unavailable');
      await screen.unmount();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
