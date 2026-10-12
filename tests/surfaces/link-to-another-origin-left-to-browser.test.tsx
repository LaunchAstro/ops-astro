// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A plain click on a link inside the shell is followed in the app only when
// the link resolves to this origin. A spelling the browser reads as another
// site (a backslash after the slash, a tab inside the two slashes) is the
// browser's to follow, so the shell neither cancels it nor navigates.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { Shell, type ShellProps } from '../../packages/ui/src/surfaces/Shell.tsx';
import { dockOf } from './dock-props.ts';
import { mount, type Mounted } from './mount.tsx';

const BASE: Omit<ShellProps, 'onNavigate'> = {
  face: 'agency',
  build: null,
  rail: [],
  here: '/projects/',
  title: 'Projects',
  dock: dockOf([]),
  children: null,
};

/** A plain click on a link with `href` in the page: whether it was cancelled. */
async function clickLink(page: Mounted, href: string): Promise<boolean> {
  const link = document.createElement('a');
  link.setAttribute('href', href);
  (page.find('.content') as HTMLElement).append(link);
  const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  // Read after React's handlers, then stop jsdom from trying to load it.
  let cancelled = false;
  const hear = (event: Event): void => {
    cancelled = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener('click', hear);
  try {
    await act(() => {
      link.dispatchEvent(click);
    });
  } finally {
    document.removeEventListener('click', hear);
    link.remove();
  }
  return cancelled;
}

describe('a link inside the shell', () => {
  it('to another origin is left to the browser, however its address is spelt', async () => {
    const visited: string[] = [];
    const page = await mount(<Shell {...BASE} onNavigate={(href) => visited.push(href)} />);
    const hostile = [
      '/\\evil.test/',
      '/\\\\evil.test/',
      '\\\\evil.test/',
      '/\t/evil.test/',
      '//evil.test/',
      'HtTpS://evil.test/',
    ];
    const cancelled: Record<string, boolean> = {};
    for (const href of hostile) {
      // eslint-disable-next-line no-await-in-loop -- one click at a time
      cancelled[href] = await clickLink(page, href);
    }
    expect({ cancelled, visited }).toEqual({
      cancelled: Object.fromEntries(hostile.map((href) => [href, false])),
      visited: [],
    });
  });

  it('to this origin is still followed in the app', async () => {
    const visited: string[] = [];
    const page = await mount(<Shell {...BASE} onNavigate={(href) => visited.push(href)} />);
    expect(await clickLink(page, '/task/T-1?tab=agent')).toBe(true);
    expect(visited).toEqual(['/task/T-1?tab=agent']);
  });
});
