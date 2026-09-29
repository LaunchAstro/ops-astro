// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-8, the narrow drawer. At 900 and below the rail is a modal drawer: the
// hamburger opens it, and the backdrop, Escape, a link or its own toggle close
// it. Focus moves in on open, is held there, and returns to the hamburger on
// close (TR-S-B1R-12). Its width, backdrop and slide are measured in a browser
// by `tests/browser/app-frame.mjs`; the behaviour is width-independent in the
// component, because the hamburger only shows at 900 and below.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SECTIONS } from '../../apps/web/src/manifest.ts';
import { open, type Opened } from './mp-2-1-support.tsx';
import { follow, layout, lit, press } from './frame-support.tsx';

const shellCss = readFileSync(resolve('packages/ui/src/styles/3-shell.css'), 'utf8');
const tokensCss = readFileSync(resolve('packages/ui/src/styles/1-tokens.css'), 'utf8');

let undo: () => void = () => undefined;
beforeEach(() => {
  undo = layout();
});
afterEach(() => {
  undo();
});

const shell = (app: Opened): Element | null => app.view.find('.shell');
const isOpen = (app: Opened): boolean => shell(app)?.getAttribute('data-nav') === 'open';
const inDrawer = (app: Opened): boolean =>
  app.view.find('.rail')?.contains(document.activeElement) ?? false;

async function openDrawer(address = '/projects/'): Promise<Opened> {
  const app = await open(address);
  await app.view.click('.navtoggle');
  return app;
}

describe('MP-2-8 a hamburger at 900 and below', () => {
  it('puts a menu button first in the page header, collapsed', async () => {
    const app = await open('/projects/');
    const toggle = app.view.find('.topbar .navtoggle');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.getAttribute('aria-controls')).toBe(app.view.find('.rail')?.id);
    expect(toggle?.getAttribute('aria-label')).toBe('Open the menu');
    await app.view.unmount();
  });

  it('hides it above 900 and shows it at 900 and below', () => {
    expect(shellCss).toMatch(/\.navtoggle\s*\{[^}]*display:\s*none/u);
    expect(shellCss).toMatch(
      /@media \(width <= 900px\)\s*\{[^@]*\.navtoggle\s*\{[^}]*display:\s*(?:inline-)?flex/u,
    );
  });
});

describe('MP-2-8 the drawer is min(300px, 84vw) with a 40% backdrop and the overlay shadow', () => {
  it('declares the drawer width, backdrop and shadow', () => {
    expect(shellCss).toMatch(/width:\s*min\(300px,\s*84vw\)/u);
    expect(shellCss).toMatch(/\.navbackdrop\s*\{[^}]*background:\s*var\(--scrim\)/u);
    expect(tokensCss).toMatch(/--scrim:\s*oklch\(0 0 0 \/ 0\.4\)/u);
    expect(shellCss).toMatch(
      /\.shell\[data-nav='open'\] \.rail\s*\{[^}]*box-shadow:\s*var\(--shadow-overlay\)/u,
    );
  });

  it('opens on the hamburger and draws the backdrop', async () => {
    const app = await openDrawer();
    expect(isOpen(app)).toBe(true);
    expect(app.view.find('.navbackdrop')).not.toBeNull();
    expect(app.view.find('.topbar .navtoggle')?.getAttribute('aria-expanded')).toBe('true');
    await app.view.unmount();
  });
});

describe('MP-2-8 it closes on Escape, on the backdrop and on navigation', () => {
  it('closes on Escape, and one Escape is spent on the drawer alone', async () => {
    const app = await openDrawer();
    const escape = await press(document.activeElement ?? document.body, 'Escape');
    expect(isOpen(app)).toBe(false);
    expect(escape.defaultPrevented).toBe(true);
    await app.view.unmount();
  });

  it('closes on the backdrop', async () => {
    const app = await openDrawer();
    await app.view.click('.navbackdrop');
    expect(isOpen(app)).toBe(false);
    await app.view.unmount();
  });

  it('closes on following a link in it', async () => {
    const app = await openDrawer();
    await follow(app.view, '.rail__item[href="/settings"]');
    expect(app.seen.at(-1)).toBe('/settings');
    expect(isOpen(app)).toBe(false);
    await app.view.unmount();
  });
});

describe('MP-2-8 CS-2.7 at 900 and below, open the rail as a modal drawer', () => {
  it('makes the page behind it inert while it is open, and only then', async () => {
    const app = await openDrawer();
    expect(app.view.find('.main')?.hasAttribute('inert')).toBe(true);
    await press(document.activeElement ?? document.body, 'Escape');
    expect(app.view.find('.main')?.hasAttribute('inert')).toBe(false);
    await app.view.unmount();
  });
});

describe('MP-2-8 keyboard: toggle close, focus in, trap and return (TR-S-B1R-12)', () => {
  it('moves focus into the drawer on open', async () => {
    const app = await openDrawer();
    expect(inDrawer(app)).toBe(true);
    await app.view.unmount();
  });

  it('closes on its own toggle and returns focus to the hamburger', async () => {
    const app = await openDrawer();
    const close = app.view.find('.rail .navclose');
    expect(close?.getAttribute('aria-expanded')).toBe('true');
    await app.view.click('.rail .navclose');
    expect(isOpen(app)).toBe(false);
    expect(document.activeElement).toBe(app.view.find('.topbar .navtoggle'));
    await app.view.unmount();
  });

  it('returns focus to the hamburger on Escape', async () => {
    const app = await openDrawer();
    await press(document.activeElement ?? document.body, 'Escape');
    expect(document.activeElement).toBe(app.view.find('.topbar .navtoggle'));
    await app.view.unmount();
  });

  it('holds Tab and Shift+Tab inside the drawer while it is open', async () => {
    const app = await openDrawer();
    const focusable = app.view.all('.rail a[href], .rail button') as HTMLElement[];
    const first = focusable[0];
    const last = focusable.at(-1);
    last?.focus();
    const forward = await press(last ?? document.body, 'Tab');
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    const back = await press(first ?? document.body, 'Tab', { shiftKey: true });
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    await app.view.unmount();
  });
});

describe('MP-2-8 deep link at 390', () => {
  it('reaches every Hub section from the drawer on a task opened from a deep link', async () => {
    const app = await openDrawer('/task/ABC-1');
    const hub = SECTIONS.filter((each) => each.namespace === 'agency' && each.navigable);
    expect(app.view.all('.rail .rail__item').map((a) => a.getAttribute('href'))).toEqual(
      hub.map((each) => each.path),
    );
    expect(lit(app.view)).toEqual(['Projects']);
    await follow(app.view, '.rail__item[href="/settings"]');
    expect(app.seen.at(-1)).toBe('/settings');
    await app.view.unmount();
  });
});
