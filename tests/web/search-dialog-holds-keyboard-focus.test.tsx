// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The search palette is a modal dialog: while it is open, Tab and Shift+Tab
// stay on its field, and the page behind it is inert, so no keyboard move
// reaches a background link or control. Closing it gives the page back.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { open } from './mp-2-1-support.tsx';
import { press } from './frame-support.tsx';

const held: typeof globalThis.fetch = () =>
  new Promise<Response>(() => {
    /* never answers */
  });

async function tab(shiftKey: boolean): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

describe('the open search palette holds keyboard focus', () => {
  it.each([false, true])('keeps focus on its field on Tab (shift: %s)', async (shiftKey) => {
    const { view } = await open('/projects/', { fetch: held });
    await view.click('.appbar .appbar__search');
    const field = view.find('.palette input');
    expect(document.activeElement).toBe(field);
    const event = await tab(shiftKey);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(field);
    await view.unmount();
  });

  it('makes the page behind it inert until it closes', async () => {
    const { view } = await open('/projects/', { fetch: held });
    await view.click('.appbar .appbar__search');
    expect(view.find('.appbar')?.closest('[inert]')).not.toBeNull();
    expect(view.find('.palette')?.closest('[inert]')).toBeNull();
    await press(document.activeElement ?? document.body, 'Escape');
    expect(view.find('.palette')).toBeNull();
    expect(document.querySelector('[inert]')).toBeNull();
    await view.unmount();
  });
});
