// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// UI-POLISH B1: the shell chrome every signed-in page wears. The app strip
// (DS-COMP-1) draws what is built and puts what is not in the kit's
// not-yet-built treatment; the hamburger opens the rail's drawer at 900 and
// below (DS-SIDE-17, 18); the person and the way out stay in reach.

import { useState, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { Shell, type ShellProps } from '../../packages/ui/src/surfaces/Shell.tsx';
import { mount, type Mounted } from './mount.tsx';

const BASE: ShellProps = {
  face: 'agency',
  build: null,
  rail: [{ id: 'agency:projects-board', label: 'Projects', href: '/projects/' }],
  here: '/projects/',
  title: 'Projects',
  dock: [],
  onDockTab: () => {},
  seated: false,
  children: null,
};

const navOf = (page: Mounted): string | undefined =>
  (page.find('.shell') as HTMLElement | null)?.dataset['nav'];

function Drawer(props: { readonly steps: string[] }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <Shell
      {...BASE}
      person={<span className="who">a@example.test</span>}
      navOpen={open}
      onNav={setOpen}
      onBack={() => props.steps.push('back')}
      onForward={() => props.steps.push('forward')}
    />
  );
}

describe('UI-POLISH B1 shell chrome', () => {
  it('draws the app strip above the page header for a signed-in person', async () => {
    const page = await mount(
      <Shell {...BASE} person={<span className="who">a@example.test</span>} />,
    );
    const chrome = page.find('.main > .chrome');
    expect(chrome?.firstElementChild?.className).toBe('appbar');
    expect(chrome?.lastElementChild?.className).toBe('topbar');
    expect(page.find('.appbar__r .who')?.textContent).toBe('a@example.test');
    await page.unmount();
  });

  it('draws no app strip when nobody is signed in', async () => {
    const page = await mount(<Shell {...BASE} />);
    expect(page.find('.appbar')).toBeNull();
    expect(page.find('.topbar h1')?.textContent).toBe('Projects');
    await page.unmount();
  });

  it('draws search, the client face and the timer as not built, each with its reason', async () => {
    const page = await mount(<Shell {...BASE} person={<span />} />);
    const search = page.find('.appbar__search') as HTMLButtonElement;
    const timer = page.find('.appbar__timer') as HTMLButtonElement;
    const client = page.find('.appbar .segmented__opt[aria-pressed="false"]') as HTMLButtonElement;
    const agency = page.find('.appbar .segmented__opt[aria-pressed="true"]') as HTMLButtonElement;
    expect(search.disabled).toBe(true);
    expect(search.title).toBe('Search is not available yet');
    expect(timer.disabled).toBe(true);
    expect(timer.title).toBe('Time tracking is not available yet');
    expect(client.textContent).toBe('Client');
    expect(client.disabled).toBe(true);
    expect(client.title).toBe('The client view is not available yet');
    expect(agency.textContent).toBe('Agency');
    // Presence is left out until live presence exists (PLACEHOLDERS SH-15, R30).
    expect(page.find('.viewers')).toBeNull();
    await page.unmount();
  });
});

describe('UI-POLISH B1 drawer and history', () => {
  it('opens the drawer from the hamburger and shuts it from the backdrop', async () => {
    const page = await mount(<Drawer steps={[]} />);
    expect(navOf(page)).toBeUndefined();
    expect(page.find('.navbackdrop')).toBeNull();
    expect(page.find('.topbar .navtoggle')?.getAttribute('aria-expanded')).toBe('false');

    await page.click('.topbar .navtoggle');
    expect(navOf(page)).toBe('open');
    expect(page.find('.navtoggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(page.find('.navtoggle')?.getAttribute('aria-label')).toBe('Close navigation');

    await page.click('.navbackdrop');
    expect(navOf(page)).toBeUndefined();
    expect(page.find('.navbackdrop')).toBeNull();
    await page.unmount();
  });

  it('steps back and forward through the tab’s pages', async () => {
    const steps: string[] = [];
    const page = await mount(<Drawer steps={steps} />);
    await page.click('.appbar__nav button[aria-label="Back"]');
    await page.click('.appbar__nav button[aria-label="Forward"]');
    expect(steps).toEqual(['back', 'forward']);
    await page.unmount();
  });
});
