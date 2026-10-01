// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-3-2c: the grip and motion, and the geometry driving the layout. The grip
// sets one width for every panel, by pointer or keyboard; the first layout
// does not animate; reduced motion is honoured; and the application seats or
// floats the group, and closes the lowest-ranked panel with a stamp where the
// window cannot hold them all (R39).

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { Dock, type DockPanel, type DockProps } from '../../packages/ui/src/surfaces/Dock.tsx';
import { App } from '../../apps/web/src/App.tsx';
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

const live: Mounted[] = [];
afterEach(async () => {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
});

const panel = (id: string): DockPanel => ({
  id,
  label: id,
  ariaLabel: id,
  door: '/projects/',
  canBack: false,
  canForward: false,
  body: null,
});

async function dock(panels: readonly DockPanel[], widths: number[], resets: number[] = []) {
  const props: DockProps = {
    tabs: panels.map((each) => ({ id: each.id, label: each.label, count: null, open: true })),
    panels,
    layout: { mode: 'floating', panelWidth: 550 },
    onTab: () => {},
    onClose: () => {},
    onCloseAll: () => {},
    onBack: () => {},
    onForward: () => {},
    onDoor: () => {},
    onResize: (width) => widths.push(width),
    onResizeEnd: (width) => resets.push(width),
  };
  const page = await mount(<Dock {...props} />);
  live.push(page);
  return page;
}

const pointer = (type: string, clientX: number): Event =>
  Object.assign(new MouseEvent(type, { bubbles: true, clientX }), { pointerId: 1 });

describe('MP-3-2 pointer grip', () => {
  it('drags one width for every panel with pointer events, saved on release', async () => {
    const widths: number[] = [];
    const saved: number[] = [];
    const page = await dock([panel('a'), panel('b')], widths, saved);
    const grip = page.find('.dpanel__grip') as HTMLElement;
    grip.setPointerCapture = () => {};
    await act(() => {
      grip.dispatchEvent(pointer('pointerdown', 1000));
      grip.dispatchEvent(pointer('pointermove', 900));
      grip.dispatchEvent(pointer('pointerup', 900));
    });
    // Two panels share the 100px the group grew by.
    expect(widths).toEqual([600]);
    expect(saved).toEqual([600]);
    expect(Object.hasOwn((page.find('.dock') as HTMLElement).dataset, 'dragging')).toBe(false);
  });
});

describe('MP-3-2 keyboard grip', () => {
  it('is a focusable separator the arrows resize and Home resets', async () => {
    const widths: number[] = [];
    const saved: number[] = [];
    const page = await dock([panel('a')], widths, saved);
    const grip = page.find('.dpanel__grip') as HTMLElement;
    expect(grip.getAttribute('role')).toBe('separator');
    expect(grip.getAttribute('tabindex')).toBe('0');
    expect(grip.getAttribute('aria-valuenow')).toBe('550');
    expect(grip.getAttribute('aria-valuemin')).toBe('380');
    const press = async (key: string, shiftKey = false): Promise<void> => {
      await act(() => {
        grip.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
      });
    };
    await press('ArrowLeft');
    await press('ArrowRight');
    await press('ArrowLeft', true);
    await press('Home');
    expect(saved).toEqual([566, 534, 614, 550]);
  });
});

describe('MP-3-2 no first animation', () => {
  it('marks the dock ready only after its first layout, and animates only when ready', async () => {
    const page = await dock([panel('a')], []);
    expect(Object.hasOwn((page.find('.dock') as HTMLElement).dataset, 'ready')).toBe(false);
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 60);
      });
    });
    expect(Object.hasOwn((page.find('.dock') as HTMLElement).dataset, 'ready')).toBe(true);
    expect(SHEET).toMatch(/\.shell\[data-dock-ready\]\s*\{[^}]*transition:/u);
    expect(SHEET).not.toMatch(/\n\.shell\s*\{[^}]*transition:/u);
  });
});

describe('MP-3-2 reduced motion', () => {
  it('drops the dock and shell transitions when the person asks for less motion', () => {
    const block = SHEET.slice(SHEET.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toMatch(
      /^@media \(prefers-reduced-motion: reduce\) \{\s*\.shell[^{]*,\s*\.dock[^{]*\{\s*transition: none/u,
    );
  });
});

const open = async (page: Mounted, id: string, shiftKey = false): Promise<void> => {
  await act(() => {
    page
      .find(`.dock__tab[data-panel="${id}"]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey }));
  });
};
const shellWidth = (page: Mounted): string =>
  (page.find('.shell') as HTMLElement).style.getPropertyValue('--dock-w');

const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };
const REGISTRY: PanelRegistry = {
  ai: {
    label: 'Client intelligence',
    ariaLabel: 'Client intelligence',
    route: 'agency:settings',
  },
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
async function at(width: number): Promise<Mounted> {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
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

describe('MP-3-2 layout from geometry', () => {
  it('seats one panel at 2400 as the grid track, and floats it at 1480', async () => {
    const wide = await at(2400);
    await open(wide, 'todos');
    expect((wide.find('.dock') as HTMLElement | null)?.dataset['mode']).toBe('seated');
    expect(shellWidth(wide)).toBe('550px');
    const narrow = await at(1480);
    await open(narrow, 'todos');
    expect((narrow.find('.dock') as HTMLElement | null)?.dataset['mode']).toBe('floating');
    expect(shellWidth(narrow)).toBe('0px');
  });

  it('follows the window when it is resized', async () => {
    const page = await at(2400);
    await open(page, 'todos');
    await act(() => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
      window.dispatchEvent(new Event('resize'));
    });
    expect((page.find('.dock') as HTMLElement | null)?.dataset['mode']).toBe('floating');
  });

  it('closes the lowest-ranked of three at 1280 and says so in one line (R39)', async () => {
    const page = await at(1280);
    await open(page, 'ai');
    await open(page, 'todos', true);
    await open(page, 'settings', true);
    expect(page.all('.dpanel').map((each) => (each as HTMLElement).dataset['panelId'])).toEqual([
      'ai',
      'todos',
    ]);
    expect(page.find('.dock__stamp')?.textContent).toBe(
      'Settings closed: three panels do not fit at this width.',
    );
    expect(page.find('.dock__stamp')?.getAttribute('role')).toBe('status');
    // Closed through the open set, as any close is: its tab reads closed too.
    expect(page.find('.dock__tab[data-panel="settings"]')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
  });
});

// The store's server legs (another person, another business, an agent under a
// live delegation; no audit) run against a fresh Postgres in
// layout-preferences-api.test.tsx.
describe('MP-3-2 width in one store', () => {
  afterEach(unmountLayouts);

  it('the width round-trips as dock.width in the one preference store: drawn from it, saved to it once on release', async () => {
    const heard: Heard[] = [];
    const page = await layoutAt({
      width: 1480,
      storage: tab(),
      heard,
      stored: { 'dock.width': 480 },
    });
    expect(heard.some((each) => each.at.endsWith('/preference/read'))).toBe(true);
    await openTab(page, 'todos');
    expect(gripValue(dockGrip(page))).toBe(480);
    // Pulled 40 then 60 to the left: wider, live, and one save on release.
    await drag(dockGrip(page), 'x', 900, [880, 860, 840]);
    expect(gripValue(dockGrip(page))).toBe(540);
    expect(savesIn(heard)).toEqual([['dock.width', 540]]);
  });

  it('MP-3-2 own preference only: the save names no person, and another person in the tab never draws this width', async () => {
    const heard: Heard[] = [];
    const storage = tab();
    const page = await layoutAt({ width: 1480, storage, heard });
    await openTab(page, 'todos');
    await drag(dockGrip(page), 'x', 900, [823]);
    expectNoPersonNamed(heard, 1);
    await unmountLayouts();
    noaSignsIn(storage);
    const noa = await layoutAt({ width: 1480, storage, heard: [] });
    await openTab(noa, 'todos');
    expect(gripValue(dockGrip(noa))).toBe(550);
  });

  it('MP-3-2 drag keeps width: a drag and a reload keep the width', async () => {
    const storage = tab();
    const page = await layoutAt({ width: 1480, storage, heard: [] });
    await openTab(page, 'todos');
    await drag(dockGrip(page), 'x', 900, [950, 1000]);
    expect(gripValue(dockGrip(page))).toBe(450);
    await unmountLayouts();
    // The reload's read is not answered yet: the first render already has it.
    const again = await layoutAt({ width: 1480, storage, heard: [] });
    await openTab(again, 'todos');
    expect(gripValue(dockGrip(again))).toBe(450);
  });
});
