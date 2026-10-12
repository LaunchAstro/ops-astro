// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Back to a dock panel that was scrolled puts its scroll back even when the
// panel's read lands after the walk: while the body is still short the
// browser holds its scroll at the top, so the saved top is put back once the
// content has grown tall enough to reach it. Once the person scrolls, it is
// theirs, and later content never moves it.

import { act, useEffect, useState, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { Dock, type DockPanel, type DockProps } from '../../packages/ui/src/surfaces/Dock.tsx';
import { dockOf } from './dock-props.ts';
import { mount } from './mount.tsx';

/** A panel whose read lands when the test says, then grows by a row more each time. */
function Late(props: { readonly rows: Promise<number>[] }): ReactElement {
  const [count, setCount] = useState(1);
  useEffect(() => {
    for (const rows of props.rows) {
      void rows.then(setCount);
    }
  }, [props.rows]);
  return (
    <ul>
      {Array.from({ length: count }, (_, at) => (
        <li key={at}>Row {at}</li>
      ))}
    </ul>
  );
}

/** A promise the test resolves. */
function held(): { readonly promise: Promise<number>; readonly resolve: (rows: number) => void } {
  let resolve!: (rows: number) => void;
  const promise = new Promise<number>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The browser's scroll on `body`: held between the top and how far the content reaches. */
function clamp(body: HTMLElement): { reach: number } {
  const room = { reach: 0 };
  let top = 0;
  Object.defineProperty(body, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, room.reach));
    },
  });
  return room;
}

describe('a dock panel walked back to', () => {
  it('gets its saved scroll once its late content is tall enough, and keeps the person’s own scroll after', async () => {
    const first = held();
    const more = held();
    const rows = [first.promise, more.promise];
    const panel = (scrollTop?: number): DockPanel => ({
      id: 'todos',
      label: 'Projects',
      ariaLabel: 'Projects',
      door: '/projects/',
      canBack: true,
      canForward: false,
      body: <Late rows={rows} />,
      scrollTop,
    });
    const dock = (restoreWalk: number, scrollTop?: number): DockProps => ({
      ...dockOf([]),
      panels: [panel(scrollTop)],
      restoreWalk,
    });
    const page = await mount(<Dock {...dock(0)} />);
    const body = page.find('.dpanel__body') as HTMLElement;
    const room = clamp(body);

    // Back, while the panel's read is still out: the body is too short.
    await page.render(<Dock {...dock(1, 600)} />);
    expect(body.scrollTop).toBe(0);

    // The read lands and the body grows past the saved top.
    await act(async () => {
      room.reach = 2000;
      first.resolve(40);
      await first.promise;
    });
    expect(body.querySelectorAll('li')).toHaveLength(40);
    expect(body.scrollTop).toBe(600);

    // The person scrolls, then more content lands: their scroll stands.
    body.scrollTop = 120;
    await act(() => {
      body.dispatchEvent(new Event('scroll'));
    });
    await act(async () => {
      more.resolve(60);
      await more.promise;
    });
    expect(body.querySelectorAll('li')).toHaveLength(60);
    expect(body.scrollTop).toBe(120);
  });

  it('stops reaching for its saved scroll once the person scrolls, before the content is tall enough', async () => {
    const some = held();
    const more = held();
    const rest = held();
    const dock = (restoreWalk: number, scrollTop?: number): DockProps => ({
      ...dockOf([]),
      panels: [
        {
          id: 'todos',
          label: 'Projects',
          ariaLabel: 'Projects',
          door: '/projects/',
          canBack: true,
          canForward: false,
          body: <Late rows={[some.promise, more.promise, rest.promise]} />,
          scrollTop,
        },
      ],
      restoreWalk,
    });
    const page = await mount(<Dock {...dock(0)} />);
    const body = page.find('.dpanel__body') as HTMLElement;
    const room = clamp(body);
    await page.render(<Dock {...dock(1, 600)} />);

    // Part of the read lands: the scroll goes as far as the body reaches,
    // and the browser's scroll event for that move is not the person's.
    await act(async () => {
      room.reach = 300;
      some.resolve(20);
      await some.promise;
    });
    expect(body.scrollTop).toBe(300);
    await act(() => {
      body.dispatchEvent(new Event('scroll'));
    });
    // More lands, still short of the saved top: it keeps reaching.
    await act(async () => {
      room.reach = 450;
      more.resolve(30);
      await more.promise;
    });
    expect(body.scrollTop).toBe(450);

    // The person scrolls up, then the rest lands: their scroll stands.
    body.scrollTop = 50;
    await act(() => {
      body.dispatchEvent(new Event('scroll'));
    });
    await act(async () => {
      room.reach = 2000;
      rest.resolve(60);
      await rest.promise;
    });
    expect(body.querySelectorAll('li')).toHaveLength(60);
    expect(body.scrollTop).toBe(50);
  });
});
