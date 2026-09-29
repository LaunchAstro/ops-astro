// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-1: the theme is applied before first paint, from a preference handed to
// the page, and follows the system when none is given.
//
// The step is the classic inline script in `apps/web/index.html`'s head. It
// runs while the head is parsed, before any stylesheet or module, so the first
// frame already carries `data-theme`. The preference is handed to it as
// `data-theme-preference` on the root element: light, dark or system. No store
// is read here; MP-2-11 owns the stored preference and hands it over that way.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../apps/web/index.html'),
  'utf8',
);
const head = new DOMParser().parseFromString(html, 'text/html').head;
const step = head.querySelector('script')?.textContent ?? '';

interface System {
  dark: boolean;
  readonly listeners: ((event: { matches: boolean }) => void)[];
}

/**
 * The step run on a fresh root, as the parser runs it: before the body exists,
 * with the system scheme stubbed and the preference, if any, already on the
 * root element as served.
 */
function load(system: System, preference?: string): HTMLElement {
  const fresh = document.createElement('html');
  document.replaceChild(fresh, document.documentElement);
  if (preference !== undefined) fresh.setAttribute('data-theme-preference', preference);
  window.matchMedia = ((query: string) => ({
    media: query,
    get matches() {
      return query === '(prefers-color-scheme: dark)' && system.dark;
    },
    addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
      system.listeners.push(listener);
    },
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  new Function(step)();
  return fresh;
}

const theme = (root: HTMLElement): string | null => root.getAttribute('data-theme');
const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

describe('MP-1-1 theme before paint', () => {
  it('MP-1-1 theme before paint', async () => {
    // Before any stylesheet or module: the first script in the head, inline
    // and classic, so the parser runs it before anything paints.
    const first = head.querySelector('script, link[rel="stylesheet"], style');
    expect(first?.tagName).toBe('SCRIPT');
    expect(first?.getAttribute('type')).toBeNull();
    expect(first?.hasAttribute('src')).toBe(false);
    expect(step).not.toBe('');

    // No preference: the system decides, both ways.
    expect(theme(load({ dark: true, listeners: [] }))).toBe('dark');
    expect(theme(load({ dark: false, listeners: [] }))).toBe('light');

    // A handed preference wins over the system; system and nonsense follow it.
    expect(theme(load({ dark: false, listeners: [] }, 'dark'))).toBe('dark');
    expect(theme(load({ dark: true, listeners: [] }, 'light'))).toBe('light');
    expect(theme(load({ dark: true, listeners: [] }, 'system'))).toBe('dark');
    expect(theme(load({ dark: true, listeners: [] }, 'sepia'))).toBe('dark');

    // Following the system, a system change repaints without a reload.
    const system: System = { dark: false, listeners: [] };
    const page = load(system);
    expect(theme(page)).toBe('light');
    system.dark = true;
    for (const listener of system.listeners) listener({ matches: true });
    expect(theme(page)).toBe('dark');

    // A preference handed after load goes through the same step.
    page.setAttribute('data-theme-preference', 'light');
    await tick();
    expect(theme(page)).toBe('light');
    // And a system change no longer overrides it.
    for (const listener of system.listeners) listener({ matches: true });
    expect(theme(page)).toBe('light');
  });
});
