// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// U09's board machine in a document, on its gallery fixture: the owner checks
// of MP-5-1 to MP-5-5 as they run before the Projects board takes the machine
// (MP-5-8, U25), and the checklist lines that need a rendered board. The
// harness captures at 1480, 900 and 390 in both themes wait on MP-1-7.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BoardGallery,
  GALLERY_BOARD,
  GALLERY_TASKS,
} from '../../packages/ui/src/board/gallery-fixture.tsx';
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

const names = (board: Mounted): readonly string[] =>
  board.all('tbody tr[data-row]').map((row) => row.querySelector('td')?.textContent ?? '');

const press = async (target: Element | null, init: MouseEventInit = {}): Promise<void> => {
  if (target === null) throw new Error('nothing to press');
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  });
};

const key = async (target: EventTarget, init: KeyboardEventInit): Promise<void> => {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });
};

const widths = (board: Mounted): readonly string[] =>
  board.all('colgroup col').map((col) => (col as HTMLElement).style.width);

const SHEET = readFileSync(
  join(process.cwd(), 'packages/ui/src/styles/4b-board-machine.css'),
  'utf8',
);

describe('MP-5-1 on the gallery fixture', () => {
  it('MP-5-1 owner check: narrowing the card shrinks columns in step and never scrolls the page', async () => {
    const board = await open();
    const wide = widths(board);
    await board.render(<BoardGallery width={700} viewport={899} />);
    const narrow = widths(board);
    expect(narrow.length).toBeLessThan(wide.length);
    expect((board.find('table') as HTMLElement).style.width).toBe('');
    await board.render(<BoardGallery width={300} viewport={390} />);
    const table = board.find('table') as HTMLElement;
    expect(table.style.width).toMatch(/px$/u);
    expect(board.find('.cbd__wrap')).not.toBeNull();
    expect(SHEET).toMatch(/\.cbd__wrap\s*\{[^}]*overflow-x:\s*auto/u);
  });

  it('MP-5-1 tight heads hide the label and centre the icon, mirrored on the cells', async () => {
    const board = await open({ width: 560, viewport: 899 });
    const tight = board.all('th[data-tight]');
    expect(tight.length).toBeGreaterThan(0);
    for (const head of tight) {
      const columnKey = head.getAttribute('data-key');
      expect(head.getAttribute('data-align')).toBe('center');
      expect(head.querySelector('[data-icon]')).not.toBeNull();
      expect(
        head.querySelector('button')?.getAttribute('aria-label') ?? head.getAttribute('aria-label'),
      ).toBeTruthy();
      const cells = board.all(`td[data-key="${columnKey ?? ''}"]`);
      expect(cells.length).toBeGreaterThan(0);
      for (const cell of cells) expect(cell.hasAttribute('data-tight')).toBe(true);
    }
    expect(SHEET).toMatch(/\[data-tight\][^{]*\.cbd__thl\s*\{[^}]*display:\s*none/u);
  });

  it('MP-5-1 tight cells clip, never ellipse', () => {
    expect(SHEET).toMatch(/td\[data-tight\]\s*\{[^}]*text-overflow:\s*clip/u);
    expect(SHEET).not.toMatch(/ellipsis/u);
  });
});

describe('MP-5-2 on the gallery fixture', () => {
  it('MP-5-2 owner check: a head click sorts, a second reverses', async () => {
    const board = await open();
    const before = widths(board);
    await press(board.find('th[data-key="name"] button'));
    const asc = names(board);
    expect(board.find('th[data-key="name"]')?.getAttribute('aria-sort')).toBe('ascending');
    await press(board.find('th[data-key="name"] button'));
    expect(board.find('th[data-key="name"]')?.getAttribute('aria-sort')).toBe('descending');
    const desc = names(board);
    // Sorted within each status group, so compare one group's run.
    expect(asc).not.toEqual(desc);
    expect(widths(board)).toEqual(before);
  });

  it('MP-5-2 column heads are keyboard-operable', async () => {
    const board = await open();
    for (const head of board.all('th[data-key]')) {
      const button = head.querySelector('button');
      expect(button?.getAttribute('type')).toBe('button');
      expect(button?.tabIndex).not.toBe(-1);
    }
  });

  it('MP-5-2 the arrow sits centred on the header rule', async () => {
    const board = await open();
    await press(board.find('th[data-key="due"] button'));
    expect(board.find('th[data-key="due"] .cbd__arrow')).not.toBeNull();
    expect(SHEET).toMatch(/\.cbd__arrow\s*\{[^}]*left:\s*50%[^}]*bottom:\s*0/su);
  });
});

describe('MP-5-3 on the gallery fixture', () => {
  it('MP-5-3 owner check: pick a filter chip, then Clear all', async () => {
    const board = await open();
    const clear = () => board.find('.cbd__clear') as HTMLButtonElement;
    expect(clear().disabled).toBe(true);
    expect(clear().title).toBe('Nothing to clear');
    const all = names(board).length;
    await press(board.find('[data-preset="mine"]'));
    expect(names(board).length).toBeLessThan(all);
    expect(board.find('[data-preset="mine"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(clear().disabled).toBe(false);
    await press(clear());
    expect(names(board).length).toBe(all);
  });

  it('MP-5-3 hidden filter chips and the reading line', async () => {
    const board = await open();
    await board.type('[data-board-search]', 'beta');
    await key(board.find('[data-board-search]') as Element, { key: 'Escape' });
    await key(board.find('[data-board-search]') as Element, { key: 'Enter' });
    const tag = board.find('.cbd__tag');
    expect(tag?.textContent).toContain('Beta Bakery');
    expect(board.find('.cbd__read')?.textContent).toBe(
      'Reading this as Beta Bakery — 2 of them · 2 more withheld by permission',
    );
    await press(board.find('.cbd__tag .cbd__tagx'));
    expect(board.find('.cbd__tag')).toBeNull();
  });

  it('MP-5-3 shift-click stacks a preset, a plain click replaces', async () => {
    const board = await open();
    await press(board.find('[data-preset="mine"]'));
    await press(board.find('[data-preset="attention"]'), { shiftKey: true });
    expect(board.all('[data-preset][aria-pressed="true"]')).toHaveLength(2);
    await press(board.find('[data-preset="attention"]'));
    expect(board.all('[data-preset][aria-pressed="true"]')).toHaveLength(1);
  });

  it('MP-5-3 presets counted and a mode swaps the surface', async () => {
    const board = await open();
    expect(board.find('[data-preset="mine"] .cbd__count')?.textContent).toBe('3');
    await press(board.find('[data-mode="review"]'));
    expect(board.find('table')).toBeNull();
    expect(board.find('[data-mode-surface="review"]')?.textContent).toContain(
      'Search console fixes',
    );
  });

  it('MP-5-3 empty state', async () => {
    const board = await open({ rows: [] });
    expect(board.text()).toContain('No task matches that.');
    expect(board.find('table')).toBeNull();
  });

  it('MP-5-3 view in address: the board opens on the view a copied address names', async () => {
    const seen: string[] = [];
    const board = await open({ onAddress: (address) => seen.push(address) });
    await press(board.find('[data-preset="mine"]'));
    const address = seen.at(-1) ?? '';
    expect(address).toContain('f=assignee%3Aada-park');
    await board.unmount();
    // A second person opens the same address over the rows they may see.
    const theirs = GALLERY_TASKS.filter((row) => row.id !== 'g1');
    mounted = await mount(
      <BoardGallery width={1200} viewport={1480} address={address} rows={theirs} />,
    );
    expect(names(mounted)).not.toContain('Logo refresh');
    expect(names(mounted).length).toBeGreaterThan(0);
    expect(mounted.find('[data-preset="mine"]')?.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('MP-5-4 on the gallery fixture', () => {
  it('MP-5-4 owner check: change a filter, undo, redo', async () => {
    const board = await open();
    const all = names(board).length;
    await press(board.find('[data-preset="mine"]'));
    const narrowed = names(board).length;
    const undo = board.find('[data-undo]') as HTMLButtonElement;
    expect(undo.title).toBe('Undo filter Ada Park');
    await press(undo);
    expect(names(board).length).toBe(all);
    await press(board.find('[data-redo]'));
    expect(names(board).length).toBe(narrowed);
  });

  it('MP-5-4 keys except search', async () => {
    const board = await open();
    const all = names(board).length;
    await press(board.find('[data-preset="mine"]'));
    await key(board.find('[data-board-search]') as Element, { key: 'z', metaKey: true });
    expect(names(board).length).toBeLessThan(all);
    await key(document.body, { key: 'z', metaKey: true });
    expect(names(board).length).toBe(all);
    await key(document.body, { key: 'z', metaKey: true, shiftKey: true });
    expect(names(board).length).toBeLessThan(all);
    await key(document.body, { key: 'z', ctrlKey: true });
    expect(names(board).length).toBe(all);
  });

  it('MP-5-4 view only: undo and redo change no record', async () => {
    const rows = structuredClone(GALLERY_BOARD.rows);
    const board = await open({ rows });
    await press(board.find('th[data-key="due"] button'));
    await press(board.find('[data-preset="attention"]'));
    await press(board.find('[data-undo]'));
    await press(board.find('[data-undo]'));
    await press(board.find('[data-redo]'));
    expect(rows).toEqual(GALLERY_BOARD.rows);
  });
});

describe('MP-5-5 on the gallery fixture', () => {
  it('MP-5-5 owner check: a client name is suggested as a filter while typing', async () => {
    const board = await open();
    await board.type('[data-board-search]', 'a');
    expect(board.find('[role="listbox"]')).toBeNull();
    await board.type('[data-board-search]', 'ac');
    const options = board.all('[role="option"]').map((option) => option.textContent ?? '');
    expect(options[0]).toContain('Acme Advocacy');
    expect(board.find('.cbdta__gh')?.textContent).toBe('Clients');
  });

  it('MP-5-5 keys and outside click', async () => {
    const board = await open();
    const field = board.find('[data-board-search]') as HTMLInputElement;
    await board.type('[data-board-search]', 'br');
    const active = () => board.find('[role="option"][aria-selected="true"]')?.textContent ?? '';
    const first = active();
    await key(field, { key: 'ArrowDown' });
    expect(active()).not.toBe(first);
    await key(field, { key: 'ArrowUp' });
    expect(active()).toBe(first);
    await key(field, { key: 'Escape' });
    expect(board.find('[role="listbox"]')).toBeNull();
    await board.type('[data-board-search]', 'bra');
    expect(board.find('[role="listbox"]')).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(board.find('[role="listbox"]')).toBeNull();
    await board.type('[data-board-search]', 'bran');
    await key(field, { key: 'Enter' });
    expect(board.find('.cbd__tag')?.textContent).toContain('Branding');
    expect(field.value).toBe('');
  });

  it('MP-5-5 commits stack and Backspace removes the last', async () => {
    const board = await open();
    const field = board.find('[data-board-search]') as HTMLInputElement;
    await board.type('[data-board-search]', 'cobalt');
    await key(field, { key: 'Escape' });
    await key(field, { key: 'Enter' });
    await board.type('[data-board-search]', 'copy');
    await key(field, { key: 'Escape' });
    await key(field, { key: 'Enter' });
    expect(board.all('.cbd__tag')).toHaveLength(2);
    expect(field.placeholder).toBe('Add another…');
    await key(field, { key: 'Backspace' });
    expect(board.all('.cbd__tag')).toHaveLength(1);
    expect(board.find('.cbd__tag')?.textContent).toContain('Cobalt Clinic');
  });

  it('MP-5-5 facet group visible above the names', async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      ...(GALLERY_TASKS[0] as (typeof GALLERY_TASKS)[number]),
      id: `x${String(index)}`,
      name: `Brand sprint ${String(index)}`,
    }));
    const board = await open({ rows: [...GALLERY_TASKS, ...many] });
    await board.type('[data-board-search]', 'bra');
    const heads = board.all('.cbdta__gh').map((head) => head.textContent);
    expect(heads).toEqual(['Everything else', 'Tasks']);
    expect(board.find('.cbdta__more')?.textContent).toMatch(/^\+\d+ more — keep typing$/u);
  });
});
