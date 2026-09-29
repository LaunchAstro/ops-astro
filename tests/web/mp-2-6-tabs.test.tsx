// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-6, the tab row from the route manifest. The row is the current
// section's pages; the underline slides, across a page change too; overflow
// scrolls with a fade and an arrow at whichever edge has more (R62). That a
// long label never widens the page at 390 is measured in a browser by
// `tests/browser/app-frame.mjs`.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SECTIONS } from '../../apps/web/src/manifest.ts';
import { open } from './mp-2-1-support.tsx';
import { TAB_WIDTH, follow, layout } from './frame-support.tsx';

const shellCss = readFileSync(resolve('packages/ui/src/styles/3-shell.css'), 'utf8');

let undo: () => void = () => {};
beforeEach(() => {
  undo = layout();
});
afterEach(() => {
  undo();
});

const tabs = (view: Awaited<ReturnType<typeof open>>['view']): readonly string[] =>
  view.all('[data-tabs] a[href]').map((a) => a.textContent?.trim() ?? '');

describe('MP-2-6 tabs come from the current section, and there is no row when there are none', () => {
  it('draws the workbench section pages as its tabs', async () => {
    const { view } = await open('/clients/acme-dental/workbench/');
    const section = SECTIONS.find(
      (each) => each.namespace === 'clients' && each.id === 'connections',
    );
    expect(tabs(view)).toEqual(section?.pages.map((page) => page.label));
    await view.unmount();
  });

  it('draws no row on a section with one page', async () => {
    for (const address of ['/inbox/', '/portal/acme-dental/', '/portal/acme-dental/contact/']) {
      // oxlint-disable-next-line no-await-in-loop
      const { view } = await open(address);
      expect(view.find('[data-tabs]'), address).toBeNull();
      // oxlint-disable-next-line no-await-in-loop
      await view.unmount();
    }
  });
});

describe('MP-2-6 CS-2.6 each section pages as tabs from the registry', () => {
  it('draws the forms section with the page open as the current tab', async () => {
    const { view } = await open('/clients/acme-dental/forms/submissions/');
    expect(tabs(view)).toEqual(['Forms', 'Submissions', 'Content editor', 'Preview & embed']);
    expect(view.find('[data-tabs] [aria-current="page"]')?.textContent).toBe('Submissions');
    await view.unmount();
  });
});

describe('MP-2-6 the underline slides, including across a page change', () => {
  it('places the mark on load, then slides it to the tab followed', async () => {
    const { view, seen } = await open('/clients/acme-dental/workbench/');
    const mark = (): HTMLElement | null => view.find('.tabmark') as HTMLElement | null;
    expect(mark()?.hasAttribute('data-placing')).toBe(true);
    expect(mark()?.style.getPropertyValue('--tabmark-x')).toBe('0px');

    const click = await follow(
      view,
      '[data-tabs] a[href="/clients/acme-dental/workbench/google-ads/"]',
    );
    expect(click.defaultPrevented).toBe(true);
    expect(seen.at(-1)).toBe('/clients/acme-dental/workbench/google-ads/');
    const index = tabs(view).indexOf('Google Ads');
    expect(mark()?.hasAttribute('data-placing')).toBe(false);
    expect(mark()?.style.getPropertyValue('--tabmark-x')).toBe(`${index * TAB_WIDTH}px`);
    expect(mark()?.style.getPropertyValue('--tabmark-w')).toBe(`${TAB_WIDTH}px`);
    await view.unmount();
  });

  it('slides on the 420ms duration', () => {
    expect(shellCss).toMatch(/\.tabmark\s*\{[^}]*transition:[^;]*var\(--dur-2\)/u);
  });
});

describe('MP-2-6 overflow scrolls horizontally with a fade and arrow buttons at whichever edge has more (R62)', () => {
  it('shows an arrow and a fade only at an edge with more tabs past it, and scrolls on the arrow', async () => {
    const { view } = await open('/clients/acme-dental/workbench/');
    const scroller = view.find('.tabbar__scroll') as HTMLElement;
    let left = 0;
    Object.defineProperties(scroller, {
      scrollWidth: { configurable: true, get: () => 1800 },
      clientWidth: { configurable: true, get: () => 600 },
      scrollLeft: {
        configurable: true,
        get: () => left,
        set: (value: number) => {
          left = value;
        },
      },
    });
    const scrollBy = vi.fn();
    scroller.scrollBy = scrollBy as unknown as typeof scroller.scrollBy;
    const edges = (): readonly string[] =>
      view.all('.tabbar__arrow').map((arrow) => arrow.getAttribute('data-edge') ?? '');
    const scrollTo = async (value: number): Promise<void> => {
      left = value;
      await act(async () => {
        scroller.dispatchEvent(new Event('scroll'));
      });
    };

    await scrollTo(0);
    expect(edges()).toEqual(['end']);
    expect(view.find('.tabbar')?.getAttribute('data-more')).toBe('end');
    await scrollTo(600);
    expect(edges()).toEqual(['start', 'end']);
    await scrollTo(1200);
    expect(edges()).toEqual(['start']);

    await view.click('.tabbar__arrow[data-edge="start"]');
    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ left: expect.any(Number) }));
    const [asked] = scrollBy.mock.calls[0] ?? [];
    expect((asked as { left: number } | undefined)?.left).toBeLessThan(0);
    await view.unmount();
  });

  it('hides the scrollbar and fades an edge with more', () => {
    expect(shellCss).toMatch(/\.tabbar__scroll\s*\{[^}]*overflow-x:\s*auto/u);
    expect(shellCss).toMatch(/\.tabbar__scroll\s*\{[^}]*scrollbar-width:\s*none/u);
    expect(shellCss).toMatch(/\.tabbar\[data-more[^\]]*\] \.tabbar__scroll\s*\{[^}]*mask-image/u);
  });
});

describe('MP-2-6 long tab labels never push the page wider than the viewport at 390', () => {
  it('lets the row shrink below its content instead of widening its column', () => {
    expect(shellCss).toMatch(/\.tabbar\s*\{[^}]*min-width:\s*0/u);
    expect(shellCss).toMatch(/\.tabbar__t\s*\{[^}]*white-space:\s*nowrap/u);
  });
});
