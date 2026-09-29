// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-10: the Projects board's inline cell editors, drawn on synthetic rows
// (BOARDS P-37, CS-5.16). A click on the assignee, due or stage cell opens its
// editor at once: the house menu for assignee and stage, a date field for due.
// A choice saves through what the page hands in; Escape and an outside click
// cancel, saving nothing. While an editor is open the cell keeps its drawn
// value underneath and the editor lies over the cell, so the row holds its
// height and the editor is the cell's size (R47). The commands from the
// Projects screen are in mp-5-10-projects-cells-screen.test.tsx.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectsBoard } from '../../packages/ui/src/surfaces/ProjectsBoard.tsx';
import type { ProjectRow, RowActions } from '../../packages/ui/src/board/projects.ts';
import { mount, type Mounted } from './mount.tsx';

const NOW = new Date(2026, 8, 30, 10, 0);

const SHEET = readFileSync(
  join(process.cwd(), 'packages/ui/src/styles/4b-board-machine.css'),
  'utf8',
);

const row = (id: string, over: Partial<ProjectRow> = {}): ProjectRow => ({
  id,
  key: `TSK-${id}`,
  name: `Task ${id}`,
  rank: { number: null, calc: 'not ranked: missing ease' },
  starred: false,
  client: null,
  assignee: null,
  due: null,
  completed: false,
  stage: null,
  status: 'Active',
  statusPosition: 2000,
  waitReason: null,
  category: null,
  awaitingDecision: false,
  estimate: null,
  actual: null,
  comments: { client: 0, mentions: 0, latest: null },
  ...over,
});

const ROWS: readonly ProjectRow[] = [
  row('menu', {
    name: 'Menu copy',
    assignee: { id: 'p-ana', name: 'Ana Lee', agent: false },
    due: '2026-10-05T00:00:00.000Z',
    stage: 'Drafting',
  }),
  row('flyer', { name: 'Flyer', stage: 'Review' }),
];

const PEOPLE = [
  { id: 'p-ana', name: 'Ana Lee' },
  { id: 'p-ben', name: 'Ben Ito' },
];

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

interface Calls {
  readonly assigns: [string, string | null][];
  readonly dues: [string, string | null][];
  readonly stages: [string, string][];
}

const open = async (
  omit: readonly (keyof RowActions)[] | null = [],
): Promise<{
  board: Mounted;
  calls: Calls;
}> => {
  const calls: Calls = { assigns: [], dues: [], stages: [] };
  const all: RowActions = {
    people: PEOPLE,
    onAssign: (each, person) => {
      calls.assigns.push([each.id, person]);
    },
    onDue: (each, due) => {
      calls.dues.push([each.id, due]);
    },
    onStage: (each, stage) => {
      calls.stages.push([each.id, stage]);
    },
  };
  const handed = Object.fromEntries(
    Object.entries(all).filter(([name]) => !(omit ?? []).includes(name as keyof RowActions)),
  ) as RowActions;
  mounted = await mount(
    <ProjectsBoard
      rows={ROWS}
      withheld={0}
      stages={['Brief', 'Drafting']}
      href={(each) => `/tasks/${each.key}`}
      now={NOW}
      width={1400}
      viewport={1480}
      {...(omit === null ? {} : { actions: handed })}
    />,
  );
  return { board: mounted, calls };
};

const one = (board: Mounted, selector: string): HTMLElement | null =>
  board.host.querySelector<HTMLElement>(selector);

const CELL = (id: string, key: string): string => `tr[data-row="${id}"] td[data-key="${key}"]`;
const EDIT = (id: string, key: string): string => `${CELL(id, key)} button.cbd__edb`;
const EDITOR = (id: string, key: string): string => `${CELL(id, key)} .cbd__ed`;
const OPTIONS = (id: string, key: string): string =>
  `${EDITOR(id, key)} .sel__menu [role="option"]`;

const fire = async (target: Element | null, event: Event): Promise<void> => {
  // eslint-disable-next-line require-await -- act's async form flushes the event's effects
  await act(async () => {
    target?.dispatchEvent(event);
  });
};

const press = async (target: Element | null, key: string): Promise<KeyboardEvent> => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  await fire(target, event);
  return event;
};

const labels = (board: Mounted, id: string, key: string): string[] =>
  board.all(OPTIONS(id, key)).map((option) => option.textContent ?? '');

const choose = async (board: Mounted, id: string, key: string, label: string): Promise<void> => {
  const option = board.all(OPTIONS(id, key)).find((each) => each.textContent === label) as
    HTMLElement | undefined;
  await fire(option ?? null, new MouseEvent('click', { bubbles: true, cancelable: true }));
};

describe('MP-5-10 assignee, due, stage and estimate edit in place, and open at once', () => {
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

  it('the arrow keys move through the menu without saving; Enter saves the active one', async () => {
    const { board, calls } = await open();
    await board.click(EDIT('flyer', 'assignee'));
    const menu = one(board, `${EDITOR('flyer', 'assignee')} .sel__menu`);
    await press(menu, 'ArrowDown');
    await press(menu, 'ArrowDown');
    expect(calls.assigns).toStrictEqual([]);
    expect(menu?.getAttribute('aria-activedescendant')).toBe(
      board.all(OPTIONS('flyer', 'assignee'))[1]?.id,
    );
    await press(menu, 'ArrowUp');
    await press(menu, 'Enter');
    expect(calls.assigns).toStrictEqual([['flyer', 'p-ana']]);
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

  it('the stage menu holds the vocabulary in order, then stages in use outside it', async () => {
    const { board, calls } = await open();
    await board.click(EDIT('flyer', 'stage'));
    expect(labels(board, 'flyer', 'stage')).toStrictEqual(['Brief', 'Drafting', 'Review']);
    await choose(board, 'flyer', 'stage', 'Drafting');
    expect(calls.stages).toStrictEqual([['flyer', 'Drafting']]);
  });
});

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
    const { board } = await open(['onStage', 'people']);
    expect(one(board, EDIT('menu', 'stage'))).toBeNull();
    expect(one(board, EDIT('menu', 'assignee'))).toBeNull();
    expect(one(board, EDIT('menu', 'due'))).not.toBeNull();
    // The estimate waits on its stored field (MP-4-8, U20): no editor yet.
    expect(one(board, EDIT('menu', 'estimate'))).toBeNull();
  });
});
