// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-10: the Projects board's inline cell editors, drawn on synthetic rows
// (BOARDS P-37, CS-5.16). A click on the assignee, due or stage cell opens its
// editor at once: the house menu for assignee and stage, a date field for due.
// A choice saves through what the page hands in. Cancelling and the row's
// height are in mp-5-10-projects-cells-cancel-dom.test.tsx; the commands from
// the Projects screen in mp-5-10-projects-cells-screen.test.tsx.

import { afterEach, describe, expect, it } from 'vitest';
import {
  EDIT,
  EDITOR,
  OPTIONS,
  choose,
  labels,
  one,
  open,
  press,
  unmount,
} from './mp-5-10-cells-fixture.tsx';

afterEach(unmount);

describe('MP-5-10 assignee, due, stage and estimate edit in place, and open at once: the assignee menu', () => {
  it('a click on the assignee opens its menu at once, the current person chosen; a choice saves', async () => {
    const { board, calls } = await open();
    await board.click(EDIT('menu', 'assignee'));
    const menu = one(board, `${EDITOR('menu', 'assignee')} .sel__menu[role="listbox"]`);
    expect(menu).not.toBeNull();
    expect(document.activeElement).toBe(menu);
    expect(labels(board, 'menu', 'assignee')).toStrictEqual(['Ana Lee', 'Ben Ito', 'Unassigned']);
    expect(
      board.all(OPTIONS('menu', 'assignee')).map((option) => option.getAttribute('aria-selected')),
    ).toStrictEqual(['true', 'false', 'false']);
    await choose(board, 'menu', 'assignee', 'Ben Ito');
    expect(calls.assigns).toStrictEqual([['menu', 'p-ben']]);
    expect(one(board, EDITOR('menu', 'assignee'))).toBeNull();
  });

  it('Unassigned clears the assignee, and choosing the current value saves nothing', async () => {
    const { board, calls } = await open();
    await board.click(EDIT('menu', 'assignee'));
    await choose(board, 'menu', 'assignee', 'Ana Lee');
    expect(one(board, EDITOR('menu', 'assignee'))).toBeNull();
    await board.click(EDIT('menu', 'assignee'));
    await choose(board, 'menu', 'assignee', 'Unassigned');
    expect(calls.assigns).toStrictEqual([['menu', null]]);
  });

  it('the menu opens on the current value; the arrow keys move without saving; Enter saves the active one', async () => {
    const { board, calls } = await open();
    await board.click(EDIT('menu', 'assignee'));
    const menu = one(board, `${EDITOR('menu', 'assignee')} .sel__menu`);
    const optionId = (at: number): string | undefined =>
      board.all(OPTIONS('menu', 'assignee'))[at]?.id;
    expect(menu?.getAttribute('aria-activedescendant')).toBe(optionId(0));
    await press(menu, 'ArrowDown');
    await press(menu, 'ArrowDown');
    await press(menu, 'ArrowDown');
    expect(calls.assigns).toStrictEqual([]);
    expect(menu?.getAttribute('aria-activedescendant')).toBe(optionId(2));
    await press(menu, 'ArrowUp');
    await press(menu, 'Enter');
    expect(calls.assigns).toStrictEqual([['menu', 'p-ben']]);
    expect(document.activeElement).toBe(one(board, EDIT('menu', 'assignee')));
  });
});

describe('MP-5-10 assignee, due, stage and estimate edit in place, and open at once: the date field and the stage menu', () => {
  it('the stage menu holds the vocabulary in order, then stages in use outside it', async () => {
    const { board, calls } = await open();
    await board.click(EDIT('flyer', 'stage'));
    expect(labels(board, 'flyer', 'stage')).toStrictEqual(['Brief', 'Drafting', 'Review']);
    await choose(board, 'flyer', 'stage', 'Drafting');
    expect(calls.stages).toStrictEqual([['flyer', 'Drafting']]);
  });

  it('a typed day waits for Enter; a half-typed one is never saved', async () => {
    const { board, calls } = await open();
    await board.click(EDIT('menu', 'due'));
    const field = one(board, `${EDITOR('menu', 'due')} input[type="date"]`);
    await press(field, '2');
    await board.type(`${EDITOR('menu', 'due')} input[type="date"]`, '0002-10-05');
    expect(calls.dues).toStrictEqual([]);
    expect(one(board, EDITOR('menu', 'due'))).not.toBeNull();
    await press(field, '6');
    await board.type(`${EDITOR('menu', 'due')} input[type="date"]`, '2026-10-06');
    await press(field, 'Enter');
    expect(calls.dues).toStrictEqual([['menu', '2026-10-06']]);
  });

  it('a click on the due date opens the date field at once on its day; a new day saves', async () => {
    const { board, calls } = await open();
    await board.click(EDIT('menu', 'due'));
    const field = one(board, `${EDITOR('menu', 'due')} input[type="date"]`) as HTMLInputElement;
    expect(field.value).toBe('2026-10-05');
    expect(document.activeElement).toBe(field);
    await board.type(`${EDITOR('menu', 'due')} input[type="date"]`, '2026-10-09');
    expect(calls.dues).toStrictEqual([['menu', '2026-10-09']]);
    expect(one(board, EDITOR('menu', 'due'))).toBeNull();
  });

  it('an emptied date clears the due date', async () => {
    const { board, calls } = await open();
    await board.click(EDIT('menu', 'due'));
    await board.type(`${EDITOR('menu', 'due')} input[type="date"]`, '');
    expect(calls.dues).toStrictEqual([['menu', null]]);
  });
});
