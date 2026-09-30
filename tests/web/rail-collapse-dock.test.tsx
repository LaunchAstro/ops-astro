// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-2-3, the rail beside the dock: the dock's geometry measures the rail as
// drawn, at 900 and below the rail is the drawer, and the preference store's
// legs wait on MP-2-11 (named it.todo below).

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { at, grip, key, railWidth, shell, unmountAll } from './rail-app.tsx';
import type { Mounted } from '../surfaces/mount.tsx';

const SHEET = readFileSync('packages/ui/src/styles/3-shell.css', 'utf8');

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

describe('MP-2-3 the preference store', () => {
  it.todo(
    'MP-2-3 width in one store: rail.width and rail.collapsed are keys of the one preference store (waits on MP-2-11)',
  );
  it.todo(
    'MP-2-3 own preference only: preference saved writes only the signed-in person row; a write to another person row is refused (waits on MP-2-11)',
  );
  it.todo('MP-2-3 no audit: a rail preference save and read add no audit event (waits on MP-2-11)');
  it.todo('MP-2-3 reload keeps it: fold, drag wider, reload, as left (waits on MP-2-11)');
  it.todo(
    'MP-2-3 visual match: /dashboard/ rail collapsed at 1480, 900 and 390, light and dark (waits on MP-1-7)',
  );
});
