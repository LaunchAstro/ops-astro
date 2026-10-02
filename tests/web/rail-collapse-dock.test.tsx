// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-2-3, the rail beside the dock: the dock's geometry measures the rail as
// drawn, at 900 and below the rail is the drawer, and the rail is kept as
// `rail.width` and `rail.collapsed` in MP-2-11's one preference store.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { at, grip, key, railWidth, shell, unmountAll } from './rail-app.tsx';
import type { Mounted } from '../surfaces/mount.tsx';
import {
  drag,
  expectNoPersonNamed,
  layoutAt,
  noaSignsIn,
  savesIn,
  tab,
  unmountLayouts,
  type Heard,
} from './layout-store-app.tsx';

// The shell's sheet and the dock's, split from it: one cascade.
const SHEET = ['3-shell.css', '3-dock.css']
  .map((sheet) => readFileSync(`packages/ui/src/styles/${sheet}`, 'utf8'))
  .join('\n');

afterEach(unmountAll);

const openTodos = async (page: Mounted): Promise<void> => {
  await act(() => {
    page
      .find('.dock__tab[data-panel="todos"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};
const mode = (page: Mounted): string | null =>
  (page.find('.dock') as HTMLElement | null)?.dataset['mode'] ?? null;

describe('MP-2-3 the dock follows the rail', () => {
  it('seats a panel beside a folded rail where the open rail leaves no room', async () => {
    // At 1500 one 550 panel needs 224 + 836 + 40 + 550 = 1650 beside an open
    // rail, and 56 + 836 + 40 + 550 = 1482 beside a folded one.
    const page = await at({ width: 1500 });
    await openTodos(page);
    expect(mode(page)).toBe('floating');
    await page.click('.railfold');
    expect(mode(page)).toBe('seated');
    expect(shell(page).style.getPropertyValue('--dock-w')).toBe('550px');
  });

  it('floats the panel when the rail is dragged wide enough to take its seat', async () => {
    // At 1700: 1700 - 224 - 876 = 600 seats 550; 1700 - 400 - 876 = 424 does not.
    const page = await at({ width: 1700 });
    await openTodos(page);
    expect(mode(page)).toBe('seated');
    await key(grip(page), 'ArrowRight', true);
    await key(grip(page), 'ArrowRight', true);
    await key(grip(page), 'ArrowRight', true);
    expect(railWidth(page)).toBe('400px');
    expect(mode(page)).toBe('floating');
  });
});

describe('MP-2-3 at 900 and below the rail is the drawer', () => {
  it('hides the fold and the grip, and the strip rules never reach the drawer', () => {
    const phone = SHEET.slice(SHEET.indexOf('/* -- The rail folds (MP-2-3)'));
    expect(phone).toMatch(
      /@media not all and \(max-width: 900px\) \{\s*\.shell\[data-rail='collapsed'\]/u,
    );
    expect(SHEET).toMatch(
      /@media \(width <= 900px\) \{\s*\.railfold,\s*\.railgrip \{\s*display: none;/u,
    );
  });
});

const railGrip = (page: Mounted): HTMLElement => {
  const found = page.find('.railgrip') as HTMLElement;
  found.setPointerCapture = () => {};
  return found;
};

// The store's server legs (another person, another business, an agent under a
// live delegation; no audit) run against a fresh Postgres in
// layout-preferences-api.test.tsx.
describe('MP-2-3 kept in the one preference store', () => {
  afterEach(unmountLayouts);

  it('MP-2-3 width in one store: rail.width and rail.collapsed are keys of the one preference store', async () => {
    const heard: Heard[] = [];
    const stored = { 'rail.width': 300, 'rail.collapsed': true };
    const page = await layoutAt({ width: 1480, storage: tab(), heard, stored });
    expect(shell(page).dataset['rail']).toBe('collapsed');
    expect(railWidth(page)).toBe('56px');
    await page.click('.railfold');
    expect(railWidth(page)).toBe('300px');
    // Dragged 20 then 40 wider: live, and one save on release.
    await drag(railGrip(page), 'x', 300, [320, 340]);
    expect(railWidth(page)).toBe('340px');
    expect(savesIn(heard)).toEqual([
      ['rail.collapsed', false],
      ['rail.width', 340],
    ]);
  });

  it('MP-2-3 own preference only: the save names no person, and another person in the tab never draws this rail', async () => {
    const heard: Heard[] = [];
    const storage = tab();
    const page = await layoutAt({ width: 1480, storage, heard });
    await drag(railGrip(page), 'x', 224, [391]);
    await page.click('.railfold');
    expectNoPersonNamed(heard, 2);
    await unmountLayouts();
    noaSignsIn(storage);
    const noa = await layoutAt({ width: 1480, storage, heard: [] });
    expect(shell(noa).dataset['rail']).toBe('expanded');
    expect(railWidth(noa)).toBe('224px');
  });

  it('MP-2-3 reload keeps it: fold, drag wider, reload, as left', async () => {
    const storage = tab();
    const page = await layoutAt({ width: 1480, storage, heard: [] });
    await drag(railGrip(page), 'x', 224, [300, 320]);
    await page.click('.railfold');
    await unmountLayouts();
    // The reload's read is not answered yet: the first render already has it.
    const again = await layoutAt({ width: 1480, storage, heard: [] });
    expect(shell(again).dataset['rail']).toBe('collapsed');
    expect(railWidth(again)).toBe('56px');
    await again.click('.railfold');
    expect(railWidth(again)).toBe('320px');
  });
});

describe('MP-2-3 the preference store', () => {
  it.todo(
    'MP-2-3 visual match: /dashboard/ rail collapsed at 1480, 900 and 390, light and dark (waits on MP-1-7)',
  );
});
