// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-5, the app strip. Back and Forward walk this tab's history through the
// real `window.history` (jsdom's), Forward is disabled with nothing ahead
// (TR-S-B1R-13), search and the timer ship disabled on the agency face with a
// tooltip naming the feature and search is hidden on the portal (R29), and no
// presence avatars are drawn (R30). The hide rules at 900 and 640 and the two
// strip colours are measured in a browser by `tests/browser/app-frame.mjs`.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppStrip } from '../../packages/ui/src/index.ts';
import { Root } from '../../apps/web/src/root.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { granted, open, session, silent, storage } from './mp-2-1-support.tsx';
import { follow, layout } from './frame-support.tsx';

const shellCss = readFileSync(resolve('packages/ui/src/styles/3-shell.css'), 'utf8');

let undo: () => void = () => undefined;
beforeEach(() => {
  undo = layout();
  window.history.replaceState(null, '', '/');
  window.sessionStorage.clear();
});
afterEach(() => {
  undo();
});

/** The real application root over jsdom's own history, as the browser entry mounts it. */
async function rooted(address: string): Promise<Mounted> {
  window.history.replaceState(null, '', address);
  const held = storage({ 'ops-astro.session': JSON.stringify(session('alpha')) });
  return mount(
    <Root
      window={window}
      sessions={new SessionStore(held.like)}
      storage={null}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={silent}
      clientAccess={granted}
    />,
  );
}

/** Wait for jsdom's history traversal to fire its popstate and React to draw it. */
async function traversed(): Promise<void> {
  await act(async () => {
    await new Promise((done) => {
      window.addEventListener('popstate', done, { once: true });
    });
  });
}

const button = (view: Mounted, name: string): HTMLButtonElement | null =>
  view.find(`.appbar button[aria-label="${name}"]`) as HTMLButtonElement | null;

describe('MP-2-5 CS-2.3 step back and forward through the pages visited in this tab', () => {
  it('walks back and forward between two visited pages with the strip buttons', async () => {
    const view = await rooted('/projects/');
    await follow(view, '.rail__item[href="/settings"]');
    expect(window.location.pathname).toBe('/settings');
    expect(button(view, 'Back')?.disabled).toBe(false);

    await act(async () => {
      button(view, 'Back')?.click();
    });
    await traversed();
    expect(window.location.pathname).toBe('/projects/');
    expect(view.find('h1')?.textContent).toBe('Projects');
    expect(button(view, 'Forward')?.disabled).toBe(false);

    await act(async () => {
      button(view, 'Forward')?.click();
    });
    await traversed();
    expect(window.location.pathname).toBe('/settings');
    expect(view.find('h1')?.textContent).toBe('Settings');
    await view.unmount();
  });
});

describe('MP-2-5 back and forward use the history', () => {
  it('pushes a history entry per in-app navigation and reads the address back on popstate', async () => {
    const view = await rooted('/projects/');
    const before = window.history.length;
    await follow(view, '.rail__item[href="/settings"]');
    expect(window.history.length).toBe(before + 1);
    await view.unmount();
  });
});

describe('MP-2-5 forward is disabled when there is no later history entry (TR-S-B1R-13)', () => {
  it('disables Forward on a fresh visit and after a new navigation drops the pages ahead', async () => {
    const view = await rooted('/projects/');
    expect(button(view, 'Forward')?.disabled).toBe(true);
    expect(button(view, 'Back')?.disabled).toBe(true);
    await follow(view, '.rail__item[href="/settings"]');
    await act(async () => {
      button(view, 'Back')?.click();
    });
    await traversed();
    expect(button(view, 'Forward')?.disabled).toBe(false);
    await follow(view, '.rail__item[href="/clients/"]');
    expect(button(view, 'Forward')?.disabled).toBe(true);
    await view.unmount();
  });
});

describe('MP-2-5 the client identity shows on client pages', () => {
  it('shows it on the workspace and the portal, and not on a Hub page', async () => {
    for (const [address, shown] of [
      ['/clients/acme-dental/projects/', true],
      ['/portal/acme-dental/', true],
      ['/projects/', false],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const { view } = await open(address);
      expect(view.find('.appbar .clienthdr') !== null, address).toBe(shown);
      // oxlint-disable-next-line no-await-in-loop
      await view.unmount();
    }
  });
});

describe('MP-2-5 search and Start timer ship disabled with a tooltip on the agency side; the portal hides search (R29)', () => {
  // C1 builds search in this slice, so the application's search is live; the
  // strip still draws it disabled, naming the feature, wherever no search is
  // wired, and the timer stays disabled until MP-4-6.
  it('draws search disabled with a tooltip where none is wired, and the timer disabled', async () => {
    const strip = await mount(<AppStrip face="agency" client={null} />);
    const search = strip.find('.appbar__search');
    expect(search?.getAttribute('aria-disabled')).toBe('true');
    expect(search?.getAttribute('title')).toBe('Search is not built yet');
    await strip.unmount();
    const { view } = await open('/projects/');
    const timer = view.find('.appbar .appbar__timer') as HTMLButtonElement | null;
    expect(timer?.disabled).toBe(true);
    expect(timer?.getAttribute('title')).toBe('Time tracking is not built yet');
    await view.unmount();
  });

  it('hides search and the timer on the portal', async () => {
    const { view } = await open('/portal/acme-dental/');
    expect(view.find('.appbar .appbar__search')).toBeNull();
    expect(view.find('.appbar .appbar__timer')).toBeNull();
    await view.unmount();
  });
});

describe('MP-2-5 presence avatars are left out until real presence exists (R30)', () => {
  it('draws no avatar or viewer in the strip', async () => {
    const { view } = await open('/clients/acme-dental/');
    // The signed-in person's own circle (C23, `.who`) is not presence: it is
    // who is signed in, drawn whether or not anyone else is looking.
    const presence = view
      .all('.appbar .viewers, .appbar .av, .appbar img')
      .filter((each) => each.closest('.who') === null);
    expect(presence).toHaveLength(0);
    await view.unmount();
  });
});

describe('MP-2-5 hide rules at 900 and 640 as specified', () => {
  it('hides search at 900, and Back, Forward and the timer label at 640', () => {
    const at900 = /@media \(width <= 900px\)\s*\{([^@]*)\}/gu;
    const at640 = /@media \(width <= 640px\)\s*\{([^@]*)\}/gu;
    const within = (pattern: RegExp): string =>
      [...shellCss.matchAll(pattern)].map((match) => match[1] ?? '').join('\n');
    expect(within(at900)).toMatch(/\.appbar__search\s*\{[^}]*display:\s*none/u);
    expect(within(at640)).toMatch(/\.appbar__step\s*\{[^}]*display:\s*none/u);
    expect(within(at640)).toMatch(/\.appbar__timer \.appbar__label\s*\{[^}]*display:\s*none/u);
  });
});

describe('MP-2-5 agency strip in the dark chrome colour; client strip teal', () => {
  it('paints the agency strip with the chrome and the client strip with the brand teal', () => {
    expect(shellCss).toMatch(/\.appbar\s*\{[^}]*background:\s*var\(--app-chrome\)/u);
    expect(shellCss).toMatch(
      /\.appbar\[data-face='client'\]\s*\{[^}]*background:\s*var\(--client-brand\)/u,
    );
  });
});
