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
import { afterEach, describe, expect, it } from 'vitest';
import { BoardGallery, GALLERY_BOARD } from '../../packages/ui/src/board/gallery-fixture.tsx';
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
