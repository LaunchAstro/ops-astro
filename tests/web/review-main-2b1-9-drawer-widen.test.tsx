// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-MAIN-2B1-9, red proof. The narrow drawer (MP-2-8) is held open in
// `App` and only a change of address closes it. While it is open the shell sets
// `inert` on `<main>` and the side-panel dock. Above 900px the stylesheet hides
// the backdrop, the hamburger and the drawer's close button, so a drawer opened
// at 820 and then widened past 900 leaves the page inert with no visible way
// out. Nothing listens to a resize or a media-query change. Widening must close
// the drawer and take `inert` off the page.
//
// jsdom lays nothing out and has no `matchMedia`, so the width is stood in for:
// `innerWidth` is set, a `matchMedia` that answers width queries against it is
// installed before mount, and widening fires both `change` on every query whose
// answer flipped and `resize` on the window. A fix may listen to either.

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open, type Opened } from './mp-2-1-support.tsx';
import { layout } from './frame-support.tsx';

type Listener = (event: MediaQueryListEvent) => void;

interface Query {
  readonly media: string;
  matches: boolean;
  readonly listeners: Set<Listener>;
  onchange: Listener | null;
}

/** Whether `media` holds at `width`; only the width forms the shell could use. */
function holds(media: string, width: number): boolean {
  const parts = [...media.matchAll(/\(\s*([a-z-]+)\s*(<=|>=|<|>|:)\s*(\d+(?:\.\d+)?)px\s*\)/gu)];
  if (parts.length === 0) return false;
  return parts.every(([, feature, op, value]) => {
    const n = Number(value);
    if (feature === 'max-width' && op === ':') return width <= n;
    if (feature === 'min-width' && op === ':') return width >= n;
    if (feature !== 'width') return false;
    if (op === '<=') return width <= n;
    if (op === '>=') return width >= n;
    if (op === '<') return width < n;
    if (op === '>') return width > n;
    return width === n;
  });
}

let width = 820;
const queries: Query[] = [];
let undoLayout: () => void = () => {};
let saved: {
  innerWidth?: PropertyDescriptor | undefined;
  matchMedia?: PropertyDescriptor | undefined;
} = {};

function standIn(): void {
  saved = {
    innerWidth: Object.getOwnPropertyDescriptor(window, 'innerWidth'),
    matchMedia: Object.getOwnPropertyDescriptor(window, 'matchMedia'),
  };
  Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => width });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (media: string): MediaQueryList => {
      const query: Query = {
        media,
        matches: holds(media, width),
        listeners: new Set(),
        onchange: null,
      };
      queries.push(query);
      const list = {
        get matches() {
          return query.matches;
        },
        media,
        get onchange() {
          return query.onchange;
        },
        set onchange(next: Listener | null) {
          // The stand-in keeps a `MediaQueryList`'s own `onchange` slot.
          // oxlint-disable-next-line unicorn/prefer-add-event-listener
          query.onchange = next;
        },
        addEventListener: (_type: string, listener: Listener) => query.listeners.add(listener),
        removeEventListener: (_type: string, listener: Listener) =>
          query.listeners.delete(listener),
        addListener: (listener: Listener) => query.listeners.add(listener),
        removeListener: (listener: Listener) => query.listeners.delete(listener),
        dispatchEvent: () => true,
      };
      return list as unknown as MediaQueryList;
    },
  });
}

/** The window is widened to `next`: every flipped query fires `change`, then the window `resize`. */
async function widen(next: number): Promise<void> {
  width = next;
  await act(() => {
    for (const query of queries) {
      const now = holds(query.media, width);
      if (now === query.matches) continue;
      query.matches = now;
      const event = Object.assign(new Event('change'), { matches: now, media: query.media });
      for (const listener of query.listeners) listener(event as MediaQueryListEvent);
      query.onchange?.(event as MediaQueryListEvent);
    }
    window.dispatchEvent(new Event('resize'));
  });
}

beforeEach(() => {
  width = 820;
  queries.length = 0;
  undoLayout = layout();
  standIn();
});
afterEach(() => {
  undoLayout();
  for (const key of ['innerWidth', 'matchMedia'] as const) {
    const descriptor = saved[key];
    if (descriptor === undefined) Reflect.deleteProperty(window, key);
    else Object.defineProperty(window, key, descriptor);
  }
});

const isOpen = (app: Opened): boolean =>
  (app.view.find('.shell') as HTMLElement | null)?.dataset['nav'] === 'open';

describe('REVIEW-MAIN-2B1-9: a drawer opened at 900 and below is left open, and the page inert, after widening past 900', () => {
  it('closes the drawer and takes inert off the page when the window widens past 900', async () => {
    const app = await open('/projects/');
    await app.view.click('.navtoggle');
    // Setup holds: the drawer is open at 820 and the page behind it is inert.
    expect(isOpen(app)).toBe(true);
    expect(app.view.find('.main')?.hasAttribute('inert')).toBe(true);

    await widen(1200);

    expect(
      app.view.find('.main')?.hasAttribute('inert'),
      'main is still inert after widening to 1200, with the hamburger, close button and backdrop hidden',
    ).toBe(false);
    expect(app.view.find('.dock__rail')?.hasAttribute('inert') ?? false).toBe(false);
    expect(isOpen(app), 'the shell still says the drawer is open after widening to 1200').toBe(
      false,
    );
    await app.view.unmount();
  });
});
