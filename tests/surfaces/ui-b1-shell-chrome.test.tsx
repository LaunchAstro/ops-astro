// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// UI-POLISH B1: the shell chrome every signed-in page wears, on SL10's frame
// (U06). The app strip, the tab row and the page header travel together as
// one block (DS-COMP-1); the hamburger opens the rail's drawer at 900 and
// below (DS-SIDE-17, 18), and the drawer shuts on the backdrop, on Escape and
// on a rail item (SIDEBAR T-R9). The strip's own parts (history, search, the
// face switch, the timer) are pinned by tests/web/mp-2-5-strip.test.tsx.

import { act, useState, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { Shell, type ShellProps } from '../../packages/ui/src/surfaces/Shell.tsx';
import { mount, type Mounted } from './mount.tsx';

const BASE: ShellProps = {
  face: 'agency',
  build: null,
  rail: [
    {
      id: 'agency:projects-board',
      label: 'Projects',
      href: '/projects/',
      lit: true,
      exact: true,
    },
  ],
  here: '/projects/',
  title: 'Projects',
  dock: [],
  onDockTab: () => {},
  seated: false,
  children: null,
};

const navOf = (page: Mounted): string | undefined =>
  (page.find('.shell') as HTMLElement | null)?.dataset['nav'];

function Drawer(): ReactElement {
  const [open, setOpen] = useState(false);
  // The address never changes here, as a press on the page already open does not.
  return <Shell {...BASE} nav={{ open, onToggle: setOpen }} onNavigate={() => {}} />;
}

describe('UI-POLISH B1 shell chrome', () => {
  it('draws the app strip, the tab row and the page header as one block', async () => {
    const page = await mount(
      <Shell
        {...BASE}
        strip={<header className="appbar" />}
        tabs={{
          id: 'projects',
          label: 'Projects',
          entries: [{ id: 'board', label: 'Board', href: '/projects/', current: true }],
        }}
      />,
    );
    const parts = [...(page.find('.main > .chrome')?.children ?? [])].map((el) => el.className);
    expect(parts).toEqual(['appbar', 'tabbar', 'topbar']);
    expect(page.find('.content .tabbar')).toBeNull();
    await page.unmount();
  });

  it('draws no app strip when none is given', async () => {
    const page = await mount(<Shell {...BASE} />);
    expect(page.find('.appbar')).toBeNull();
    expect(page.find('.topbar h1')?.textContent).toBe('Projects');
    await page.unmount();
  });
});

describe('UI-POLISH B1 drawer', () => {
  it('opens the drawer from the hamburger and shuts it from the backdrop', async () => {
    const page = await mount(<Drawer />);
    expect(navOf(page)).toBeUndefined();
    expect(page.find('.navbackdrop')).toBeNull();
    expect(page.find('.topbar .navtoggle')?.getAttribute('aria-expanded')).toBe('false');

    await page.click('.topbar .navtoggle');
    expect(navOf(page)).toBe('open');
    expect(page.find('.navtoggle')?.getAttribute('aria-expanded')).toBe('true');

    await page.click('.navbackdrop');
    expect(navOf(page)).toBeUndefined();
    expect(page.find('.navbackdrop')).toBeNull();
    await page.unmount();
  });

  it('shuts the drawer on Escape and on a rail item, as SIDEBAR T-R9 asks', async () => {
    const page = await mount(<Drawer />);
    await page.click('.topbar .navtoggle');
    expect(navOf(page)).toBe('open');
    await act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(navOf(page)).toBeUndefined();

    await page.click('.topbar .navtoggle');
    expect(navOf(page)).toBe('open');
    // The page already open: moving does not change `here`, so the click shuts it.
    await page.click('.rail__item[aria-current="page"]');
    expect(navOf(page)).toBeUndefined();
    await page.unmount();
  });
});
