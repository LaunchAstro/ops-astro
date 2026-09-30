// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-7, the page header and sticky chrome. The strip, the tab row and the
// header travel as one chrome block, sticky at 901 and above and scrolling
// away at 900 and below; that is measured by scrolling in a browser in
// `tests/browser/app-frame.mjs`. The freshness marker is the kit's (MP-1-6):
// an indicator with five states and no sync button (CS-1.1, TR-S-B1R-11).

// oxlint-disable no-await-in-loop

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Shell, type Freshness } from '../../packages/ui/src/index.ts';
import { dockOf } from '../surfaces/dock-props.ts';
import { mount } from '../surfaces/mount.tsx';
import { open } from './mp-2-1-support.tsx';

const shellCss = readFileSync(resolve('packages/ui/src/styles/3-shell.css'), 'utf8');
const tokensCss = readFileSync(resolve('packages/ui/src/styles/1-tokens.css'), 'utf8');

describe('MP-2-7 H1 in display 24/500 with a meta slot', () => {
  it('titles the page with one h1 in the header, beside a meta slot', async () => {
    const { view } = await open('/projects/');
    expect(view.all('h1')).toHaveLength(1);
    expect(view.find('.topbar .topbar__title h1.t-title')?.textContent).toBe('Projects');
    expect(view.find('.topbar .topbar__meta')).not.toBeNull();
    await view.unmount();
  });

  it('sets the title in the display face at 24, weight 500', () => {
    const title = /\.topbar__title \.t-title\s*\{([^}]*)\}/u.exec(shellCss)?.[1] ?? '';
    // The header takes the scale's title style (MP-1-4), which is display 24/500.
    expect(title).toMatch(/font:\s*var\(--type-title\)/u);
    const token = (name: string): string =>
      new RegExp(`${name}:\\s*([^;]+);`, 'u').exec(tokensCss)?.[1]?.trim() ?? '';
    expect(token('--type-title')).toMatch(
      /^var\(--weight-medium\) var\(--text-h1\)\/\S+ var\(--font-display\)$/u,
    );
    expect(token('--text-h1')).toBe('24px');
  });
});

describe('MP-2-7 the chrome is sticky at 901 and above and scrolls away at 900 and below', () => {
  it('holds the strip, the tab row and the header in one chrome block', async () => {
    const { view } = await open('/clients/acme-dental/workbench/');
    const chrome = view.find('.chrome');
    expect(chrome?.querySelector('.appbar')).not.toBeNull();
    expect(chrome?.querySelector('[data-tabs]')).not.toBeNull();
    expect(chrome?.querySelector('.topbar')).not.toBeNull();
    await view.unmount();
  });

  it('declares sticky above 900 only', () => {
    expect(shellCss).toMatch(
      /@media not all and \(max-width: 900px\)\s*\{\s*\.chrome\s*\{[^}]*position:\s*sticky/u,
    );
    expect(/\.chrome\s*\{[^}]*position:\s*sticky/u.test(shellCss.split('@media')[0] ?? '')).toBe(
      false,
    );
  });
});

describe('MP-2-7 one title inset for every page kind', () => {
  it('draws the title the same way on a built page, a reserved one, a client one, the portal and a refusal', async () => {
    const shapes = new Set<string>();
    for (const address of [
      '/projects/',
      '/dashboard/',
      '/clients/acme-dental/projects/',
      '/portal/acme-dental/',
      '/clients/zenith-plumbing/',
      '/nowhere-at-all/',
    ]) {
      const { view } = await open(address);
      const title = view.find('h1');
      shapes.add(
        `${title?.parentElement?.className}>${title?.className}|${title?.closest('header')?.className}`,
      );
      await view.unmount();
    }
    expect([...shapes]).toEqual(['topbar__title>t-title|topbar']);
  });
});

const FIVE_STATES: readonly Freshness[] = [
  { state: 'live', age: '2 min ago' },
  { state: 'catching-up', lastRead: '10:42' },
  { state: 'offline', lastRead: '10:42' },
  { state: 'source-behind', source: 'Xero', lastGood: '9:10', href: '/connections/' },
  { state: 'frozen', at: 'Saturday 6:10am' },
];

const headerWith = (freshness: Freshness): ReactElement => (
  <Shell
    face="agency"
    build={null}
    rail={[]}
    here="/projects/"
    title="Projects"
    freshness={freshness}
    dock={dockOf([])}
  >
    {null}
  </Shell>
);

describe('MP-2-7 the freshness marker: five states, an indicator only, no sync button (TR-S-B1R-11)', () => {
  const views: { unmount: () => Promise<void> }[] = [];
  afterEach(async () => {
    for (const each of views.splice(0)) await each.unmount();
  });

  it('places each of the five states in the header in words, as a status and never a control', async () => {
    const words: string[] = [];
    for (const freshness of FIVE_STATES) {
      const view = await mount(headerWith(freshness));
      views.push(view);
      const marker = view.find(`.topbar .topbar__meta .fresh--${freshness.state}`);
      expect(marker?.getAttribute('role'), freshness.state).toBe('status');
      expect(marker?.tagName).toBe('SPAN');
      expect(marker?.hasAttribute('tabindex')).toBe(false);
      expect(marker?.querySelectorAll('button, a, [role="button"]')).toHaveLength(0);
      words.push(marker?.textContent ?? '');
    }
    expect(words).toEqual([
      'Updated 2 min ago',
      'Reconnecting · last read 10:42',
      'Offline · showing data from 10:42',
      'Xero behind · last good 9:10',
      'Frozen Saturday 6:10am',
    ]);
  });

  it('places the marker in the header when the connection drops, and never a sync button', async () => {
    const { view } = await open('/projects/');
    const online = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
    Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false });
    try {
      await act(() => {
        window.dispatchEvent(new Event('offline'));
      });
      const marker = view.find('.topbar .topbar__meta .fresh--offline');
      expect(marker?.textContent).toMatch(/^Offline · showing data from \d{1,2}:\d{2}/u);
      const controls = view.all('.topbar button').map((each) => each.textContent ?? '');
      expect(controls.filter((text) => /sync|refresh|reload/iu.test(text))).toEqual([]);
    } finally {
      if (online !== undefined) Object.defineProperty(Navigator.prototype, 'onLine', online);
      await act(() => {
        window.dispatchEvent(new Event('online'));
      });
    }
    expect(view.find('.fresh')).toBeNull();
    await view.unmount();
  });
});
