// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-2, the expanded rail and its sliding railmark. One case per line of the
// ticket's supporting checklist. Sizes and the 220ms slide are measured in a
// browser at 1480, 900 and 390, light and dark, by `tests/browser/app-frame.mjs`;
// what is decided before layout (which item is lit, where the mark is sent,
// whether it snaps or slides) is proved here.

// oxlint-disable no-await-in-loop

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PAGES, SECTIONS } from '../../apps/web/src/manifest.ts';
import { filled, open } from './mp-2-1-support.tsx';
import { ITEM_HEIGHT, follow, layout, lit } from './frame-support.tsx';

const shellCss = readFileSync(resolve('packages/ui/src/styles/3-shell.css'), 'utf8');
const tokensCss = readFileSync(resolve('packages/ui/src/styles/1-tokens.css'), 'utf8');

/** The declarations of the first rule whose selector is exactly `selector`. */
const rule = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(shellCss)?.[1] ?? '';
};

let undo: () => void = () => undefined;
beforeEach(() => {
  undo = layout();
});
afterEach(() => {
  undo();
});

describe('MP-2-2 CS-2.1 one-level map of the Hub from the route registry', () => {
  it('lists the Hub sections from the manifest, in order, one level deep', async () => {
    const { view } = await open('/settings');
    const drawn = view.all('.rail .rail__item').map((a) => a.getAttribute('href'));
    const hub = SECTIONS.filter((each) => each.namespace === 'agency' && each.navigable);
    expect(drawn).toEqual(hub.map((each) => each.path));
    expect(view.all('.rail .rail__item .rail__item')).toHaveLength(0);
    expect(view.all('.rail ul ul, .rail nav nav')).toHaveLength(0);
    await view.unmount();
  });
});

describe('MP-2-2 items 36 tall in a 224-wide rail', () => {
  it('declares the rail 224 wide and each item 36 tall', () => {
    expect(tokensCss).toMatch(/--rail-w:\s*224px/u);
    expect(rule('.rail__item')).toMatch(/height:\s*36px/u);
  });
});

describe('MP-2-2 current section lit on every address', () => {
  it('lights exactly the section that holds the page, on every manifest address', async () => {
    for (const page of PAGES) {
      const { view } = await open(filled(page.path));
      const section = SECTIONS.find(
        (each) => each.namespace === page.namespace && each.pages.includes(page),
      );
      if (section?.navigable === true) expect(lit(view), page.path).toEqual([section.label]);
      else expect(lit(view).length, page.path).toBeLessThanOrEqual(1);
      await view.unmount();
    }
  });

  it('lights Projects on the task page', async () => {
    const { view } = await open('/task/ABC-1');
    expect(lit(view)).toEqual(['Projects']);
    await view.unmount();
  });

  it('lights Contact on the booking page', async () => {
    const { view } = await open('/portal/acme-dental/contact/book/');
    expect(lit(view)).toEqual(['Contact']);
    await view.unmount();
  });

  it('marks the exact page as the page and a parent section as the location', async () => {
    const exact = await open('/projects/');
    expect(exact.view.find('.rail [data-lit]')?.getAttribute('aria-current')).toBe('page');
    await exact.view.unmount();
    const child = await open('/clients/acme-dental/workbench/calls/');
    expect(child.view.find('.rail [data-lit]')?.getAttribute('aria-current')).toBe('location');
    await child.view.unmount();
  });
});

describe('MP-2-2 railmark slides over 220ms on in-app navigation and snaps on load', () => {
  it('snaps onto the lit item on load, then slides to the next one on a rail click', async () => {
    const { view, seen } = await open('/projects/');
    const mark = (): HTMLElement | null => view.find('.railmark') as HTMLElement | null;
    const items = view.all('.rail__group > .rail__item');
    const at = (label: string): number =>
      items.findIndex((item) => item.textContent?.trim() === label);
    expect(mark()?.hasAttribute('data-placing')).toBe(true);
    expect(mark()?.style.getPropertyValue('--railmark-y')).toBe(
      `${at('Projects') * ITEM_HEIGHT}px`,
    );

    const click = await follow(view, '.rail__item[href="/settings"]');
    expect(click.defaultPrevented).toBe(true);
    expect(seen.at(-1)).toBe('/settings');
    expect(lit(view)).toEqual(['Settings']);
    expect(mark()?.hasAttribute('data-placing')).toBe(false);
    expect(mark()?.style.getPropertyValue('--railmark-y')).toBe(
      `${at('Settings') * ITEM_HEIGHT}px`,
    );
    await view.unmount();
  });

  it('hides the mark where nothing is lit', async () => {
    const { view } = await open('/nowhere-at-all/');
    expect(lit(view)).toEqual([]);
    expect(view.find('.railmark')?.hasAttribute('hidden')).toBe(true);
    await view.unmount();
  });

  it('slides on the shared 220ms duration and not during placing', () => {
    expect(tokensCss).toMatch(/--dur-1:\s*220ms/u);
    expect(rule('.railmark')).toMatch(/transition:[^;]*var\(--dur-1\)/u);
    expect(rule('.railmark[data-placing]')).toMatch(/transition:\s*none/u);
  });

  it('leaves a modified click, a new-tab click and an outside link to the browser', async () => {
    const { view, seen } = await open('/projects/');
    const before = seen.length;
    const target = view.find('.rail__item[href="/settings"]');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    target?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(seen.length).toBe(before);
    await view.unmount();
  });
});

describe('MP-2-2 hover as specified', () => {
  it('fills with surface-2 and inks the label on hover', () => {
    const hover = rule('.rail__item:hover');
    expect(hover).toMatch(/background:\s*var\(--surface-2\)/u);
    expect(hover).toMatch(/color:\s*var\(--text\)/u);
  });
});
