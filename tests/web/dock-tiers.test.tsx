// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-3-3: the dock's sheet tiers and the phone strip. From 901 to 1279 the
// dock is a sheet under the content, its tabs on the sheet's top edge, shift
// stacking panels in one shared height the person drags within [220, window
// height - 140]. At 900 and below the strip stays on screen at rest and one
// panel draws, the last opened. The page is padded under the sheet, nothing
// overflows sideways, and print leaves the dock out.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { App } from '../../apps/web/src/App.tsx';
import { dockGeometry } from '../../apps/web/src/dock/geometry.ts';
import type { PanelRegistry } from '../../apps/web/src/panels.ts';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import {
  dockGrip,
  drag,
  gripValue,
  expectNoPersonNamed,
  layoutAt,
  noaSignsIn,
  openTab,
  savesIn,
  tab,
  unmountLayouts,
  type Heard,
} from './layout-store-app.tsx';

// The shell's sheet and the dock's, split from it: one cascade.
const SHEET = ['3-shell.css', '3-dock.css']
  .map((sheet) => readFileSync(`packages/ui/src/styles/${sheet}`, 'utf8'))
  .join('\n');
const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };
const REGISTRY: PanelRegistry = {
  todos: { label: 'Projects', ariaLabel: 'Projects', route: 'agency:projects-board' },
  settings: { label: 'Settings', ariaLabel: 'Business settings', route: 'agency:settings' },
};

function memory(): StorageLike {
  const held = new Map([['ops-astro.session', JSON.stringify(SESSION)]]);
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  };
}

/** The bodies of every `@media` block whose query is exactly `query`, joined. */
function media(query: string): string {
  const bodies: string[] = [];
  let start = SHEET.indexOf(`@media ${query} {`);
  while (start >= 0) {
    let depth = 0;
    let end = SHEET.length;
    for (let index = SHEET.indexOf('{', start); index < SHEET.length; index += 1) {
      if (SHEET[index] === '{') depth += 1;
      if (SHEET[index] === '}') depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
    bodies.push(SHEET.slice(start, end));
    start = SHEET.indexOf(`@media ${query} {`, end);
  }
  return bodies.join('\n');
}

const live: Mounted[] = [];
afterEach(async () => {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
});

async function at(width: number, height = 1000): Promise<Mounted> {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  const storage = memory();
  const page = await mount(
    <App
      path="/projects/"
      navigate={() => {}}
      sessions={new SessionStore(storage)}
      gotrueUrl="http://gotrue.test"
      apiOrigin=""
      fetch={(() => new Promise<Response>(() => {})) as typeof globalThis.fetch}
      storage={storage as Storage}
      panels={REGISTRY}
    />,
  );
  live.push(page);
  return page;
}

async function open(page: Mounted, id: string, shiftKey = false): Promise<void> {
  await act(() => {
    page
      .find(`.dock__tab[data-panel="${id}"]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey }));
  });
}

const openIds = (page: Mounted): (string | undefined)[] =>
  page.all('.dpanel').map((each) => (each as HTMLElement).dataset['panelId']);

const geometry = (viewport: number): string =>
  dockGeometry({ viewport, navRail: 224, width: 550, open: ['todos'] }).mode;

describe('MP-3-3 sheet tier', () => {
  it('is a sheet from 901 to 1279 and a phone at 900 and below', () => {
    expect([geometry(1279), geometry(1100), geometry(901)]).toEqual(['sheet', 'sheet', 'sheet']);
    expect([geometry(900), geometry(390)]).toEqual(['phone', 'phone']);
  });

  it('stacks panels under the content on shift, sharing one height', async () => {
    const page = await at(1100);
    await open(page, 'todos');
    await open(page, 'settings', true);
    expect((page.find('.dock') as HTMLElement | null)?.dataset['mode']).toBe('sheet');
    expect(openIds(page)).toEqual(['todos', 'settings']);
    expect((page.find('.dock') as HTMLElement).style.getPropertyValue('--dock-sheet-h')).toBe(
      '460px',
    );
    const sheet = SHEET.slice(SHEET.indexOf(".dock[data-mode='sheet'] {"));
    expect(sheet).toMatch(/^\.dock\[data-mode='sheet'\] \{[^}]*position: sticky/u);
    expect(SHEET).toMatch(
      /\.dock\[data-mode='sheet'\] \.dock__panels \{[^}]*flex-direction: column/u,
    );
    expect(SHEET).toMatch(
      /\.dock\[data-mode='sheet'\] \.dock__panels \{[^}]*height: var\(--dock-sheet-h\)/u,
    );
  });

  it('puts the tabs on the sheet top edge', () => {
    expect(SHEET).toMatch(
      /\.dock\[data-mode='sheet'\] \.dock__rail \{[^}]*position: static[^}]*flex-direction: row/u,
    );
    expect(SHEET).toMatch(/\.dock\[data-mode='sheet'\] \.dock__rail \{[^}]*order: -1/u);
  });
});

describe('MP-3-3 sheet height', () => {
  it('drags one height by a row separator, clamped to 220 and the window height less 140', async () => {
    const page = await at(1100, 1000);
    await open(page, 'todos');
    const grip = page.find('.dpanel__grip') as HTMLElement;
    expect(grip.getAttribute('aria-orientation')).toBe('horizontal');
    const press = async (key: string, times: number): Promise<void> => {
      for (let turn = 0; turn < times; turn += 1) {
        // eslint-disable-next-line no-await-in-loop -- each press meets the height the last left
        await act(() => {
          grip.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true }));
        });
      }
    };
    await press('ArrowUp', 20);
    expect(page.find('.dpanel__grip')?.getAttribute('aria-valuenow')).toBe('860');
    await press('ArrowDown', 20);
    expect(page.find('.dpanel__grip')?.getAttribute('aria-valuenow')).toBe('220');
    expect(page.find('.dpanel__grip')?.getAttribute('aria-valuemax')).toBe('860');
  });
});

describe('MP-3-3 phone strip', () => {
  it('keeps the tab strip on screen at rest at 900 and below', async () => {
    const page = await at(390);
    expect((page.find('.dock') as HTMLElement | null)?.dataset['mode']).toBe('phone');
    expect((page.find('.dock') as HTMLElement | null)?.dataset['open']).toBe('0');
    expect(page.all('.dock__rail .dock__tab')).toHaveLength(2);
    const phone = media('(width <= 900px)');
    expect(phone).toMatch(/\.dock \{[^}]*bottom: 0/u);
    expect(phone).toMatch(/\.dock__rail \{[^}]*position: static[^}]*transform: none/u);
  });

  it('draws one panel, the last opened', async () => {
    const page = await at(390);
    await open(page, 'settings');
    await open(page, 'todos', true);
    expect((page.find('.dock') as HTMLElement | null)?.dataset['mode']).toBe('phone');
    expect(openIds(page)).toEqual(['todos']);
    await open(page, 'todos', true);
    expect(openIds(page)).toEqual(['settings']);
  });
});

describe('MP-3-3 page padded under the sheet', () => {
  it('pads the page by the strip at rest and by the sheet once a panel is open', () => {
    const phone = media('(width <= 900px)');
    expect(phone).toMatch(/\.main \{[^}]*padding-bottom: 40px/u);
    expect(phone).toMatch(
      /\.shell:has\(\.dock\[data-mode='phone'\]:not\(\[data-open='0'\]\)\) \.main \{[^}]*padding-bottom: calc\(var\(--dock-sheet-h\) \+ 40px\)/u,
    );
  });
});

describe('MP-3-3 no horizontal overflow at 390', () => {
  it('draws the phone panel and strip at the window width, never wider', () => {
    const phone = media('(width <= 900px)');
    expect(phone).toMatch(/\.dock \{[^}]*left: 0/u);
    expect(phone).toMatch(/\.dpanel \{[^}]*width: 100%/u);
    expect(phone).not.toMatch(/100vw/u);
  });
  // Measured at 390 on every page in a real browser: dock-visual.test.ts.
});

describe('MP-3-3 print hides the dock', () => {
  it('leaves the dock and its strip out of print', () => {
    expect(media('print')).toMatch(/\.dock \{\s*display: none/u);
  });
});

// The store's server legs (another person, another business, an agent under a
// live delegation; no audit) run against a fresh Postgres in
// layout-preferences-api.test.tsx.
describe('MP-3-3 height in one store', () => {
  afterEach(unmountLayouts);

  it('the sheet height round-trips as dock.sheetHeight in the one preference store: drawn from it, saved once on release', async () => {
    const heard: Heard[] = [];
    const stored = { 'dock.sheetHeight': 300 };
    const page = await layoutAt({ width: 1100, storage: tab(), heard, stored });
    await openTab(page, 'todos');
    expect(gripValue(dockGrip(page))).toBe(300);
    // Pulled up 20 then 50: taller, live, and one save on release.
    await drag(dockGrip(page), 'y', 700, [680, 650]);
    expect(gripValue(dockGrip(page))).toBe(350);
    expect(savesIn(heard)).toEqual([['dock.sheetHeight', 350]]);
  });

  it('MP-3-3 own preference only: the save names no person, and another person in the tab never draws this height', async () => {
    const heard: Heard[] = [];
    const storage = tab();
    const page = await layoutAt({ width: 1100, storage, heard });
    await openTab(page, 'todos');
    await drag(dockGrip(page), 'y', 700, [577]);
    expectNoPersonNamed(heard, 1);
    await unmountLayouts();
    noaSignsIn(storage);
    const noa = await layoutAt({ width: 1100, storage, heard: [] });
    await openTab(noa, 'todos');
    expect(gripValue(dockGrip(noa))).toBe(460);
  });

  it('MP-3-3 reload keeps it: a drag and a reload keep the sheet height', async () => {
    const storage = tab();
    const page = await layoutAt({ width: 1100, storage, heard: [] });
    await openTab(page, 'todos');
    await drag(dockGrip(page), 'y', 500, [600]);
    expect(gripValue(dockGrip(page))).toBe(360);
    await unmountLayouts();
    const again = await layoutAt({ width: 1100, storage, heard: [] });
    await openTab(again, 'todos');
    expect(gripValue(dockGrip(again))).toBe(360);
  });
  it.todo(
    'MP-3-3 visual match: stack2 at 1480, 1100, 950, 900 and 390, light and dark (waits on a catalogued dock state and a second registered panel)',
  );
});
