// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// U13 in a document, on the board machine's gallery fixture: MP-5-6's grips,
// drag, arrow keys and Reset columns, and MP-5-7's command bar. The owner
// checks run here until the Projects board takes the machine (MP-5-8, U25);
// the harness captures at 1480, 900 and 390 in both themes wait on MP-1-7.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BoardGallery,
  GALLERY_BOARD,
  GALLERY_FACETS,
} from '../../packages/ui/src/board/gallery-fixture.tsx';
import {
  widthsFromPreference,
  widthsToPreference,
  type ColumnWidths,
} from '../../packages/ui/src/board/index.ts';
import { mount, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const open = async (props: Parameters<typeof BoardGallery>[0] = {}): Promise<Mounted> => {
  mounted = await mount(<BoardGallery width={1200} viewport={1480} {...props} />);
  return mounted;
};

const SHEET = readFileSync(
  join(process.cwd(), 'packages/ui/src/styles/4b-board-machine.css'),
  'utf8',
);

/** Each drawn column's share, in percent, by key. */
const shares = (board: Mounted): Readonly<Record<string, number>> => {
  const heads = board.all('thead th').map((th) => th.getAttribute('data-key') ?? '');
  const cols = board.all('colgroup col').map((col) => parseFloat((col as HTMLElement).style.width));
  return Object.fromEntries(heads.map((key, at) => [key, cols[at] ?? 0]));
};

const grip = (board: Mounted, key: string): HTMLElement => {
  const found = board.find(`[data-grip="${key}"]`);
  if (found === null) throw new Error(`no grip on ${key}`);
  return found as HTMLElement;
};

const pointer = async (
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientX: number,
): Promise<void> => {
  await act(async () => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }));
  });
};

const drag = async (board: Mounted, key: string, dx: number, steps = 4): Promise<void> => {
  const handle = grip(board, key);
  await pointer(handle, 'pointerdown', 500);
  // The moves arrive as a pointer sends them, several between two paints.
  await act(async () => {
    for (let step = 1; step <= steps; step += 1) {
      window.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 500 + (dx * step) / steps }),
      );
    }
  });
  await pointer(window, 'pointerup', 500 + dx);
};

const key = async (target: EventTarget, init: KeyboardEventInit): Promise<void> => {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });
};

/** A column's floor as a share of the gallery's 1200px card. */
const floor = (column: string): number =>
  ((GALLERY_BOARD.columns.find((one) => one.key === column)?.min ?? 0) / 1200) * 100;

const undoLabel = (board: Mounted): string =>
  board.find('[data-undo]')?.getAttribute('aria-label') ?? '';

// Defaults at 1200: name 30%, client 16%, assignee 14%, due 13%, category 13%,
// client comments 4%, actual 10%.
describe('MP-5-6 on the gallery fixture', () => {
  it('MP-5-6 drag within minimums: a drag widens its column from those to its right only', async () => {
    const board = await open();
    const before = shares(board);
    await drag(board, 'client', 60);
    const after = shares(board);
    expect(after['name']).toBeCloseTo(before['name'] ?? 0, 3);
    expect(after['client']).toBeCloseTo(21, 3);
    const total = Object.values(after).reduce((sum, share) => sum + share, 0);
    expect(total).toBeCloseTo(100, 2);
    // A drag far past the room stops with every column to the right at its floor.
    await drag(board, 'client', 2000);
    const floored = shares(board);
    for (const column of ['assignee', 'due', 'category', 'waiting', 'actual']) {
      expect(floored[column]).toBeCloseTo(floor(column), 2);
    }
    // The last column has no grip.
    expect(board.find('[data-grip="actual"]')).toBeNull();
  });

  it('MP-5-6 rule accent: the grip is lit while it is dragged, and the rule is 2px accent on hover and drag', async () => {
    const board = await open();
    const handle = grip(board, 'due');
    expect(handle.classList.contains('is-live')).toBe(false);
    await pointer(handle, 'pointerdown', 400);
    await pointer(window, 'pointermove', 430);
    expect(grip(board, 'due').classList.contains('is-live')).toBe(true);
    await pointer(window, 'pointerup', 430);
    expect(grip(board, 'due').classList.contains('is-live')).toBe(false);
    expect(SHEET).toMatch(
      /\.cbd__grip::after\s*\{[^}]*width:\s*1px;[^}]*background:\s*var\(--border\)/u,
    );
    const lit = /([^{}]+)\{[^}]*width:\s*2px;[^}]*background:\s*var\(--accent\)[^}]*\}/u.exec(
      SHEET,
    );
    expect(lit?.[1]).toContain('.cbd__grip:hover::after');
    expect(lit?.[1]).toContain('.cbd__grip.is-live::after');
    expect(lit?.[1]).toContain('.cbd__grip:focus-visible::after');
  });

  it('MP-5-6 one undo per drag: many moves are one step, and Undo returns the defaults', async () => {
    const board = await open();
    const before = shares(board);
    await drag(board, 'assignee', 90, 12);
    expect(undoLabel(board)).toBe('Undo resize Assignee');
    await board.click('[data-undo]');
    expect(shares(board)).toEqual(before);
    expect(undoLabel(board)).toBe('Nothing to undo');
    // A press on a grip that moves nothing is no step, and never sorts.
    await pointer(grip(board, 'client'), 'pointerdown', 300);
    await pointer(window, 'pointerup', 300);
    await act(async () => {
      grip(board, 'client').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(undoLabel(board)).toBe('Nothing to undo');
    expect(board.all('th[aria-sort="none"]')).toHaveLength(board.all('thead th').length);
    // A drag the browser cancels leaves no width and no step.
    await pointer(grip(board, 'due'), 'pointerdown', 300);
    await pointer(window, 'pointermove', 360);
    await act(async () => {
      window.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }));
    });
    expect(shares(board)).toEqual(before);
    expect(undoLabel(board)).toBe('Nothing to undo');
    expect(board.find('.cbd__grip.is-live')).toBeNull();
  });

  it('MP-5-6 reset: the reset icon appears after a drag and returns the defaults', async () => {
    const board = await open();
    const before = shares(board);
    expect(board.find('[data-reset]')).toBeNull();
    await drag(board, 'name', -80);
    const reset = board.find('[data-reset]');
    expect(reset?.getAttribute('aria-label')).toBe('Reset columns');
    await board.click('[data-reset]');
    expect(shares(board)).toEqual(before);
    expect(board.find('[data-reset]')).toBeNull();
    expect(undoLabel(board)).toBe('Undo reset columns');
  });

  it('MP-5-6 keyboard resize: arrows on a focused grip resize its column, Shift by more', async () => {
    const board = await open();
    const handle = grip(board, 'client');
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-label')).toBe('Resize Client');
    expect(handle.tabIndex).toBe(0);
    await act(async () => {
      handle.focus();
    });
    await key(handle, { key: 'ArrowRight' });
    expect(shares(board)['client']).toBeCloseTo(((192 + 16) / 1200) * 100, 3);
    expect(undoLabel(board)).toBe('Undo resize Client');
    await key(grip(board, 'client'), { key: 'ArrowLeft', shiftKey: true });
    expect(shares(board)['client']).toBeCloseTo(((192 + 16 - 64) / 1200) * 100, 3);
    // Focus stays on the grip through the redraw, and other keys do nothing.
    expect(document.activeElement?.getAttribute('data-grip')).toBe('client');
    const now = shares(board);
    await key(grip(board, 'client'), { key: 'Enter' });
    await key(grip(board, 'client'), { key: 'a' });
    expect(shares(board)).toEqual(now);
  });

  it('MP-5-6 owner check: drag a column wider, reload, then press Reset columns', async () => {
    let stored: unknown = { 'clients.name': 240 };
    const persist = (widths: ColumnWidths | null): void => {
      stored = widthsToPreference('gallery', stored, widths);
    };
    const load = (): ColumnWidths | null =>
      widthsFromPreference('gallery', GALLERY_BOARD.columns, stored);
    let board = await open({ widths: load(), onWidths: persist });
    const before = shares(board);
    await drag(board, 'name', 120);
    const dragged = shares(board);
    expect(dragged['name']).toBeGreaterThan(before['name'] ?? 0);

    // Reload: a fresh board reads the stored widths back.
    await board.unmount();
    board = await open({ widths: load(), onWidths: persist });
    expect(shares(board)).toEqual(dragged);
    expect(undoLabel(board)).toBe('Nothing to undo');

    await board.click('[data-reset]');
    expect(shares(board)).toEqual(before);
    expect(stored).toEqual({ 'clients.name': 240 });
    await board.unmount();
    board = await open({ widths: load(), onWidths: persist });
    expect(shares(board)).toEqual(before);
  });
});

const funnelLabels = (board: Mounted): readonly string[] =>
  board.all('#cbd-menu [data-add]').map((one) => one.textContent ?? '');

const rowCount = (board: Mounted): number => board.all('tbody tr[data-row]').length;

describe('MP-5-7 on the gallery fixture', () => {
  it('MP-5-7 funnel badge: counts the filters on that no chip on the bar shows', async () => {
    const board = await open();
    const funnel = (): Element | null => board.find('[data-funnel]');
    expect(board.find('[data-funnel] [data-badge]')).toBeNull();
    expect(funnel()?.getAttribute('aria-label')).toBe('Filters');
    // A preset's chip shows its own filter: not counted.
    await board.click('[data-preset="mine"]');
    expect(board.find('[data-funnel] [data-badge]')).toBeNull();
    // A filter from the menu and a typed word have no chip of their own.
    await board.click('[data-funnel]');
    const overdue = board.find('#cbd-menu [data-add="due:overdue"]');
    await act(async () => {
      overdue?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });
    await board.type('[data-board-search]', 'zebra');
    await key(board.find('[data-board-search]') as Element, { key: 'Enter' });
    expect(board.find('[data-funnel] [data-badge]')?.textContent).toBe('2');
    expect(funnel()?.getAttribute('aria-label')).toBe('Filters, 2 on that this bar does not show');
  });

  it('MP-5-7 find a filter: narrows the controls, never the rows', async () => {
    const board = await open();
    await board.click('[data-funnel]');
    expect(document.activeElement?.id).toBe('cbd-menu-q');
    const rows = rowCount(board);
    const line = board.find('.cbd__read')?.textContent ?? '';
    await board.type('#cbd-menu-q', 'ada');
    expect(funnelLabels(board)).toEqual(['Ada Park']);
    expect(rowCount(board)).toBe(rows);
    expect(board.find('.cbd__read')?.textContent ?? '').toBe(line);
    await board.type('#cbd-menu-q', 'zzz');
    expect(funnelLabels(board)).toEqual([]);
    expect(board.find('#cbd-menu')?.textContent).toContain('No filter matches “zzz”.');
    expect(rowCount(board)).toBe(rows);
  });

  it('MP-5-7 menu closes: on Escape, with focus back on the funnel, and on an outside click', async () => {
    const board = await open();
    const menu = (): Element | null => board.find('#cbd-menu');
    await board.click('[data-funnel]');
    expect(menu()?.hasAttribute('hidden')).toBe(false);
    expect(board.find('[data-funnel]')?.getAttribute('aria-expanded')).toBe('true');
    await key(board.find('#cbd-menu-q') as Element, { key: 'Escape' });
    expect(menu()?.hasAttribute('hidden')).toBe(true);
    expect(document.activeElement?.hasAttribute('data-funnel')).toBe(true);
    // A click inside the menu keeps it open; one outside closes it.
    await board.click('[data-funnel]');
    await pointer(board.find('#cbd-menu .cbd__menuhd') as Element, 'pointerdown', 10);
    expect(menu()?.hasAttribute('hidden')).toBe(false);
    await pointer(document.body, 'pointerdown', 10);
    expect(menu()?.hasAttribute('hidden')).toBe(true);
    // The funnel toggles it.
    await board.click('[data-funnel]');
    await board.click('[data-funnel]');
    expect(menu()?.hasAttribute('hidden')).toBe(true);
  });

  it('MP-5-7 gutter at 390: the menu spans the bar inside the page gutter, never past it', () => {
    expect(SHEET).toMatch(/\.cbd__menu\s*\{[^}]*width:\s*min\(22rem,\s*calc\(100vw - 32px\)\)/u);
    const narrow = /@media \(max-width: 480px\)\s*\{([\s\S]*?)\n\}/u.exec(SHEET)?.[1] ?? '';
    expect(narrow).toMatch(/\.cbd__cmd\s*\{[^}]*position:\s*relative/u);
    expect(narrow).toMatch(/\.cbd__funnelw\s*\{[^}]*position:\s*static/u);
    expect(narrow).toMatch(/\.cbd__menu\s*\{[^}]*left:\s*0;[^}]*right:\s*0;[^}]*width:\s*auto/u);
  });

  it('MP-5-7 chip ladder: the chip row takes the first tier that fits one row', async () => {
    const real = HTMLElement.prototype.getBoundingClientRect;
    let fitsAt = '56px';
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const row = this.closest<HTMLElement>('.cbd__filters');
        if (row === null) return real.call(this);
        const fits = row.style.getPropertyValue('--catw') === fitsAt;
        const box = { x: 0, y: 0, left: 0, right: 80, width: 80, toJSON: () => ({}) };
        if (this === row) return { ...box, top: 0, bottom: 44, height: 44 };
        if (this === row.firstElementChild) return { ...box, top: 0, bottom: 30, height: 30 };
        const top = fits ? 0 : 40;
        return { ...box, top, bottom: top + 30, height: 30 };
      });
    try {
      const board = await open();
      const row = board.find('.cbd__filters') as HTMLElement;
      expect(row.getAttribute('data-tier')).toBe('56');
      expect(row.style.getPropertyValue('--catw')).toBe('56px');
      fitsAt = 'never';
      await board.render(<BoardGallery width={1100} viewport={1480} />);
      expect(row.getAttribute('data-tier')).toBe('icons');
      expect(row.style.getPropertyValue('--catw')).toBe('');
      // The icon tier keeps each chip's name for a screen reader.
      expect(board.find('[data-preset="mine"]')?.getAttribute('aria-label')).toBe('Ada Park');
      expect(SHEET).toMatch(/\[data-tier='icons'\] \.cbd__presetw\s*\{[^}]*display:\s*none/u);
      expect(SHEET).toMatch(/max-width:\s*var\(--catw\)/u);
    } finally {
      spy.mockRestore();
    }
  });

  it('MP-5-7 sticky heads: the chip row sticks under the chrome and the heads under the chip row', async () => {
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const height = this.classList.contains('cbd__filters') ? 44 : 0;
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 0,
          bottom: height,
          width: 0,
          height,
          toJSON: () => ({}),
        };
      });
    try {
      const board = await open();
      const root = board.find('.cbd') as HTMLElement;
      expect(root.style.getPropertyValue('--catbar-h')).toBe('44px');
    } finally {
      spy.mockRestore();
    }
    expect(SHEET).toMatch(
      /\.cbd__filters\s*\{[^}]*position:\s*sticky;[^}]*top:\s*var\(--chrome-h, 0px\)/u,
    );
    expect(SHEET).toMatch(
      /\.cbd__tbl thead th\s*\{[^}]*position:\s*sticky;[^}]*top:\s*calc\(var\(--chrome-h, 0px\) \+ var\(--catbar-h, 0px\)\)/u,
    );
    // A scroll container would pin the heads to itself, not the page.
    expect(SHEET).toMatch(/\.cbd__wrap\s*\{[^}]*overflow-x:\s*clip/u);
  });

  it('MP-5-7 board only: the bar sits in the title row and leaves it with the board', async () => {
    const title = document.createElement('div');
    document.body.append(title);
    try {
      const board = await open({ bar: title });
      expect(title.querySelector('[data-funnel]')).not.toBeNull();
      expect(title.querySelector('[data-board-search]')).not.toBeNull();
      expect(board.find('.cbd [data-funnel]')).toBeNull();
      // Another panel is showing: the board is hidden and its bar goes with it.
      await board.render(<BoardGallery width={1200} viewport={1480} bar={title} hidden />);
      expect(title.childElementCount).toBe(0);
      expect(board.find('.cbd')?.hasAttribute('hidden')).toBe(true);
      await board.render(<BoardGallery width={1200} viewport={1480} bar={title} />);
      expect(title.querySelector('[data-funnel]')).not.toBeNull();
    } finally {
      title.remove();
    }
  });

  it('MP-5-7 no sync button: the freshness stamp is an indicator, derived from the newest record', async () => {
    const now = new Date('2026-09-29T12:00:00Z');
    const board = await open({ changedAt: '2026-09-29T10:00:00Z', now });
    const stamp = board.find('[data-freshness]') as HTMLElement;
    expect(stamp.textContent).toContain('Updated 2 hours ago');
    expect(stamp.textContent).toContain('2h ago');
    expect(stamp.tagName).not.toBe('BUTTON');
    expect(stamp.querySelector('button, a, [tabindex]')).toBeNull();
    expect(stamp.hasAttribute('tabindex')).toBe(false);
    const buttons = board.all('button').map((one) => one.textContent ?? '');
    expect(buttons.some((text) => /sync/iu.test(text))).toBe(false);
    expect(board.text()).not.toMatch(/sync/iu);
    await board.render(<BoardGallery width={1200} viewport={1480} changedAt={null} now={now} />);
    expect(board.find('[data-freshness]')).toBeNull();
  });

  it('MP-5-7 owner check: chips and heads stay in view, and the funnel lists every filter', async () => {
    const board = await open();
    await board.click('[data-funnel]');
    expect(funnelLabels(board)).toHaveLength(5);
    const more = board.find('#cbd-menu [data-showall]');
    expect(more?.textContent).toBe(`Show all filters (${String(GALLERY_FACETS.length - 5)} more)`);
    await board.click('#cbd-menu [data-showall]');
    expect([...funnelLabels(board)].toSorted()).toEqual(
      GALLERY_FACETS.map((one) => one.label).toSorted(),
    );
    expect(board.find('#cbd-menu [data-showall]')?.textContent).toBe('Show fewer filters');
    // Ranked by rows: no filter holds more rows than the one above it.
    const counts = board
      .all('#cbd-menu [data-add]')
      .map((one) => Number(one.getAttribute('data-count')));
    // Within each kind's group the order is by count.
    const groups = board.all('#cbd-menu .cbd__menugrp');
    for (const group of groups) {
      const inGroup = [...group.querySelectorAll('[data-add]')].map((one) =>
        Number(one.getAttribute('data-count')),
      );
      expect(inGroup).toEqual([...inGroup].toSorted((a, b) => b - a));
    }
    expect(counts.length).toBe(GALLERY_FACETS.length);
    // The chip row and the heads are the sticky pair.
    expect(board.find('.cbd__filters')).not.toBeNull();
    expect(board.find('thead')).not.toBeNull();
  });
});
