// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-MAIN-2B1-10, red proof. The narrow drawer (`packages/ui/src/surfaces/drawer.ts`)
// and the search palette (`apps/web/src/search.tsx`) each add a capture-phase
// keydown listener on the document that returns early on `defaultPrevented`.
// The drawer's is added first, because the drawer was opened before the
// palette, so with the drawer open and the palette opened on Ctrl+K, one Escape
// closes the drawer under the palette and marks the key handled; the palette's
// listener then returns and the palette stays open, and focus is sent to the
// hamburger behind the palette's scrim. Both say "one Escape closes [it] and
// nothing under it": the topmost layer, the palette, must take that Escape.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open, type Opened } from './mp-2-1-support.tsx';
import { layout, press } from './frame-support.tsx';

let undo: () => void = () => {};
beforeEach(() => {
  undo = layout();
});
afterEach(() => {
  undo();
});

const isOpen = (app: Opened): boolean =>
  (app.view.find('.shell') as HTMLElement | null)?.dataset['nav'] === 'open';

describe('REVIEW-MAIN-2B1-10: Escape closes the drawer under the search palette instead of the palette', () => {
  it('spends one Escape on the palette opened over the drawer, leaving the drawer open', async () => {
    const app = await open('/projects/');
    await app.view.click('.navtoggle');
    await press(document.activeElement ?? document.body, 'k', { ctrlKey: true });
    // Setup holds: the drawer is open and the palette is drawn over it, focused.
    expect(isOpen(app)).toBe(true);
    expect(app.view.find('.palette')).not.toBeNull();
    expect(document.activeElement).toBe(app.view.find('.palette input'));

    await press(document.activeElement ?? document.body, 'Escape');

    expect(app.view.find('.palette'), 'the palette is still open after one Escape').toBeNull();
    expect(isOpen(app), 'the drawer under the palette was closed by that Escape').toBe(true);
    expect(document.activeElement).not.toBe(app.view.find('.topbar .navtoggle'));
    await app.view.unmount();
  });
});
