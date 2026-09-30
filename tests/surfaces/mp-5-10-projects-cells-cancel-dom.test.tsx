// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-10: the cell editors cancel on Escape and an outside press, saving
// nothing; while one is open the cell keeps its drawn value underneath and the
// editor lies over the cell, so the row holds its height and the editor is the
// cell's size (R47); cells whose command the page does not hand in stay as
// they are (CS-5.16).

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CELL,
  EDIT,
  EDITOR,
  SHEET,
  fire,
  one,
  open,
  press,
  unmount,
} from './mp-5-10-cells-fixture.tsx';

afterEach(unmount);

describe('MP-5-10 Escape and an outside click cancel', () => {
  it('Escape closes the menu, saves nothing, and goes no further than the cell', async () => {
    const { board, calls } = await open();
    let heard = 0;
    const host = (): void => {
      heard += 1;
    };
    document.addEventListener('keydown', host);
    await board.click(EDIT('menu', 'assignee'));
    const event = await press(one(board, `${EDITOR('menu', 'assignee')} .sel__menu`), 'Escape');
    document.removeEventListener('keydown', host);
    expect(event.defaultPrevented).toBe(true);
    expect(heard).toBe(0);
    expect(calls.assigns).toStrictEqual([]);
    expect(one(board, EDITOR('menu', 'assignee'))).toBeNull();
    expect(one(board, EDIT('menu', 'assignee'))?.textContent).toContain('Ana');
    expect(document.activeElement).toBe(one(board, EDIT('menu', 'assignee')));
  });

  it('Escape in the date field saves nothing', async () => {
    const { board, calls } = await open();
    await board.click(EDIT('menu', 'due'));
    await press(one(board, `${EDITOR('menu', 'due')} input`), 'Escape');
    expect(calls.dues).toStrictEqual([]);
    expect(one(board, EDITOR('menu', 'due'))).toBeNull();
  });

  it('a press outside the editor closes it, saving nothing', async () => {
    const { board, calls } = await open();
    await board.click(EDIT('menu', 'stage'));
    await fire(document.body, new MouseEvent('mousedown', { bubbles: true }));
    expect(one(board, EDITOR('menu', 'stage'))).toBeNull();
    expect(calls.stages).toStrictEqual([]);
  });

  it('a press inside the editor keeps it open; opening another cell closes the first', async () => {
    const { board } = await open();
    await board.click(EDIT('menu', 'stage'));
    await fire(
      one(board, `${EDITOR('menu', 'stage')} .sel__menu`),
      new MouseEvent('mousedown', { bubbles: true }),
    );
    expect(one(board, EDITOR('menu', 'stage'))).not.toBeNull();
    const other = one(board, EDIT('flyer', 'stage'));
    await fire(other, new MouseEvent('mousedown', { bubbles: true }));
    await board.click(EDIT('flyer', 'stage'));
    expect(board.all('.cbd__ed')).toHaveLength(1);
    expect(one(board, EDITOR('flyer', 'stage'))).not.toBeNull();
  });
});

describe('MP-5-10 the row holds its height while a cell editor is open, and the editor is sized to the cell', () => {
  it('the drawn value stays in the cell under the editor', async () => {
    const { board } = await open();
    const before = one(board, CELL('menu', 'assignee'))?.textContent;
    await board.click(EDIT('menu', 'assignee'));
    const cell = one(board, `${CELL('menu', 'assignee')} .cbd__cell`);
    expect(cell?.classList.contains('is-editing')).toBe(true);
    expect(cell?.querySelector(':scope > .cbd__cellv')?.textContent).toBe(before);
    expect(cell?.querySelector(':scope > .cbd__cellv')?.getAttribute('aria-hidden')).toBe('true');
    expect(cell?.querySelector(':scope > .cbd__ed')).not.toBeNull();
  });

  it('the stylesheet lays the editor over the cell and hangs the menu below it', () => {
    expect(SHEET).toMatch(/\.cbd__cell\s*\{[^}]*position:\s*relative/u);
    expect(SHEET).toMatch(
      /\.cbd__cell\.is-editing\s*>\s*\.cbd__cellv\s*\{[^}]*visibility:\s*hidden/u,
    );
    expect(SHEET).toMatch(/\.cbd__ed\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0/u);
    expect(SHEET).toMatch(
      /\.cbd__ed \.sel__menu\s*\{[^}]*position:\s*absolute;[^}]*top:\s*100%;[^}]*min-width:\s*100%;[^}]*max-width:\s*22rem/u,
    );
    // The td and the scrolling wrap lift their clipping while an editor is open.
    expect(SHEET).toMatch(
      /\.cbd__tbl td:has\(\.cbd__cell\.is-editing\),\s*\.cbd__wrap:has\(\.cbd__cell\.is-editing\)\s*\{[^}]*overflow:\s*visible/u,
    );
  });
});

describe('MP-5-10 CS-5.16 edit assignee, due, stage and time estimate in place at fixed row height', () => {
  it('a board handed no commands draws every cell as it is, with no editor', async () => {
    const { board } = await open(null);
    expect(board.all('button.cbd__edb')).toHaveLength(0);
  });

  it('a cell whose command the page does not hand in stays as it is', async () => {
    const { board } = await open(['onStage', 'people', 'onEstimate']);
    expect(one(board, EDIT('menu', 'stage'))).toBeNull();
    expect(one(board, EDIT('menu', 'assignee'))).toBeNull();
    expect(one(board, EDIT('menu', 'estimate'))).toBeNull();
    expect(one(board, EDIT('menu', 'due'))).not.toBeNull();
  });

  it('the time estimate edits in place over its drawn value, and a choice saves it', async () => {
    const { board, calls } = await open();
    await board.click(EDIT('menu', 'estimate'));
    const cell = one(board, `${CELL('menu', 'estimate')} .cbd__cell`);
    expect(cell?.classList.contains('is-editing')).toBe(true);
    expect(cell?.querySelector(':scope > .cbd__cellv')?.textContent).toBe('2h');
    const option = board
      .all(`${EDITOR('menu', 'estimate')} [role="option"]`)
      .find((each) => each.textContent === '4h');
    // eslint-disable-next-line require-await -- act's async form flushes the event's effects
    await act(async () => {
      option?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(calls.estimates).toStrictEqual([['menu', 240]]);
    expect(one(board, EDITOR('menu', 'estimate'))).toBeNull();
  });
});
