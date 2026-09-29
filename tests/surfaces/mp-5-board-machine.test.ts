// SPDX-License-Identifier: AGPL-3.0-only
//
// U09's board machine, the parts that are pure: the column model (MP-5-1), the
// sort cycle (MP-5-2), facets, presets, the reading line and Clear all
// (MP-5-3), the sixty-step view history (MP-5-4), the query parser, the
// typeahead and the address (MP-5-5). Each test is named after the ticket's
// checklist line it proves. What needs a document is in
// `mp-5-board-dom.test.tsx`, and what needs the database in
// `tests/reads/mp-5-board-isolation.test.ts`.

import { describe, expect, it } from 'vitest';
import {
  HISTORY_CAP,
  initialMachine,
  layoutColumns,
  narrowRows,
  nextSort,
  parseQuery,
  presetCount,
  pressFacet,
  readView,
  readingLine,
  reduceBoard,
  resolveShares,
  sortRows,
  suggest,
  visibleColumns,
  writeView,
  type BoardContext,
  type BoardView,
  type ColumnSpec,
  type Facet,
} from '../../packages/ui/src/board/index.ts';

interface Row {
  readonly id: string;
  readonly name: string;
  readonly client: string | null;
  readonly category: string;
  readonly due: number | null;
}

const ROWS: readonly Row[] = [
  { id: 'r1', name: 'Logo refresh', client: 'Acme Advocacy', category: 'Branding', due: 3 },
  { id: 'r2', name: 'Admin audit', client: 'Beta Bakery', category: 'Admin', due: null },
  { id: 'r3', name: 'Landing page', client: 'Acme Advocacy', category: 'Website Edits', due: 1 },
  { id: 'r4', name: 'Monthly report', client: 'Beta Bakery', category: 'Reporting', due: 2 },
  { id: 'r5', name: 'Brand guide', client: null, category: 'Branding', due: 5 },
];

const facet = (kind: string, label: string, test: (row: Row) => boolean): Facet<Row> => ({
  id: `${kind.toLowerCase()}:${label.toLowerCase().replaceAll(' ', '-')}`,
  kind,
  label,
  words: label.toLowerCase().split(' '),
  test,
});

const FACETS: readonly Facet<Row>[] = [
  facet('Client', 'Acme Advocacy', (row) => row.client === 'Acme Advocacy'),
  facet('Client', 'Beta Bakery', (row) => row.client === 'Beta Bakery'),
  facet('Category', 'Admin', (row) => row.category === 'Admin'),
  facet('Category', 'Branding', (row) => row.category === 'Branding'),
  facet('Category', 'Reporting', (row) => row.category === 'Reporting'),
];

const COLUMNS: readonly ColumnSpec<Row>[] = [
  { key: 'name', label: 'Task name', share: 40, min: 140, labelWidth: 90, align: 'start' },
  {
    key: 'client',
    label: 'Client',
    share: 25,
    min: 90,
    labelWidth: 60,
    align: 'start',
    sortValue: (row) => row.client,
  },
  {
    key: 'due',
    label: 'Due date',
    share: 20,
    min: 64,
    labelWidth: 80,
    align: 'start',
    icon: 'calendar',
    sortValue: (row) => row.due,
  },
  {
    key: 'cmt',
    label: 'Client comments',
    share: 5,
    min: 36,
    labelWidth: 0,
    align: 'center',
    iconOnly: true,
    icon: 'comment',
    firstDir: 'desc',
  },
  {
    key: 'actual',
    label: 'Actual',
    share: 10,
    min: 56,
    labelWidth: 56,
    align: 'end',
    hideBelow: 900,
  },
];

const CONTEXT: BoardContext<Row> = {
  facets: FACETS,
  columns: COLUMNS,
  presets: [{ id: 'mine', label: 'Mine', facetIds: ['category:branding'] }],
  modes: [{ id: 'review', label: 'Review' }],
};

const hay = (row: Row): string => `${row.name} ${row.client ?? ''}`;
const byId = (rows: readonly Row[]): readonly string[] => rows.map((row) => row.id);

describe('MP-5-1 column model', () => {
  it('MP-5-1 columns declare share, minimum, label width, hide-below, icon-only and alignment', () => {
    const laid = layoutColumns(COLUMNS, { viewport: 1480, available: 1200 });
    expect(laid.columns.map((column) => column.key)).toEqual([
      'name',
      'client',
      'due',
      'cmt',
      'actual',
    ]);
    for (const column of laid.columns) {
      expect(typeof column.pct).toBe('number');
      expect(['start', 'center', 'end']).toContain(column.align);
    }
    expect(laid.columns.find((column) => column.key === 'cmt')?.tight).toBe(true);
    expect(laid.columns.find((column) => column.key === 'actual')?.align).toBe('end');
  });

  it('MP-5-1 surviving columns renormalise and none goes under its minimum', () => {
    expect(visibleColumns(COLUMNS, 899).map((column) => column.key)).not.toContain('actual');
    const laid = layoutColumns(COLUMNS, { viewport: 899, available: 420 });
    const total = laid.columns.reduce((sum, column) => sum + column.pct, 0);
    expect(total).toBeCloseTo(100, 6);
    for (const column of laid.columns) {
      const spec = COLUMNS.find((one) => one.key === column.key) as ColumnSpec<Row>;
      expect(column.px + 0.5).toBeGreaterThanOrEqual(spec.min);
    }
    // Plain shares at 420 would give the comment column 23px; its floor is 36.
    const shares = resolveShares(visibleColumns(COLUMNS, 899), 420);
    expect(((shares[3] as number) / 100) * 420).toBeGreaterThanOrEqual(35.5);
  });

  it('MP-5-1 tight heads hide the label and centre the icon, mirrored on the cells', () => {
    const wide = layoutColumns(COLUMNS, { viewport: 1480, available: 1200 });
    expect(wide.columns.find((column) => column.key === 'due')?.tight).toBe(false);
    // At 360 the due column gets under its 80px label width and goes tight.
    const narrow = layoutColumns(COLUMNS, { viewport: 899, available: 360 });
    const due = narrow.columns.find((column) => column.key === 'due');
    expect(due?.tight).toBe(true);
    expect(due?.align).toBe('center');
  });

  it('MP-5-1 the table scrolls inside the card when minimums exceed it', () => {
    const laid = layoutColumns(COLUMNS, { viewport: 390, available: 300 });
    const floors = visibleColumns(COLUMNS, 390).reduce((sum, column) => sum + column.min, 0);
    expect(laid.tableWidth).toBe(floors);
    const fits = layoutColumns(COLUMNS, { viewport: 1480, available: 1200 });
    expect(fits.tableWidth).toBeNull();
  });

  it('MP-5-1 CS-5.9 lays columns out from their shares and floors at any width', () => {
    for (let available = 200; available <= 1600; available += 37) {
      const laid = layoutColumns(COLUMNS, { viewport: available, available });
      const width = laid.tableWidth ?? available;
      const sum = laid.columns.reduce((total, column) => total + column.px, 0);
      expect(Math.abs(sum - width)).toBeLessThan(1);
      expect(laid.tableWidth === null || laid.tableWidth > available).toBe(true);
    }
  });
});

describe('MP-5-2 sort cycle', () => {
  it('MP-5-2 first-press direction per column and a three-press cycle', () => {
    const due = COLUMNS[2] as ColumnSpec<Row>;
    const first = nextSort(null, due);
    expect(first).toEqual({ key: 'due', dir: 'asc' });
    const second = nextSort(first, due);
    expect(second).toEqual({ key: 'due', dir: 'desc' });
    expect(nextSort(second, due)).toBeNull();
    // A column that declares its useful direction lands on it first.
    expect(nextSort(null, COLUMNS[3] as ColumnSpec<Row>)).toEqual({ key: 'cmt', dir: 'desc' });
    // Right-aligned figures read biggest first.
    expect(nextSort(null, COLUMNS[4] as ColumnSpec<Row>)).toEqual({ key: 'actual', dir: 'desc' });
    // A press on another column starts that column's cycle.
    expect(nextSort(first, COLUMNS[1] as ColumnSpec<Row>)).toEqual({ key: 'client', dir: 'asc' });
  });

  it('MP-5-2 CS-5.7 sorts by a column, blanks last in either direction', () => {
    expect(byId(sortRows(ROWS, { key: 'due', dir: 'asc' }, COLUMNS))).toEqual([
      'r3',
      'r4',
      'r1',
      'r5',
      'r2',
    ]);
    expect(byId(sortRows(ROWS, { key: 'due', dir: 'desc' }, COLUMNS))).toEqual([
      'r5',
      'r1',
      'r4',
      'r3',
      'r2',
    ]);
    expect(byId(sortRows(ROWS, null, COLUMNS))).toEqual(byId(ROWS));
  });

  it('MP-5-2 no column changes width when the sort changes', () => {
    const before = layoutColumns(COLUMNS, { viewport: 1480, available: 1200 });
    let machine = initialMachine();
    machine = reduceBoard(machine, { type: 'sort', key: 'due' }, CONTEXT);
    const after = layoutColumns(COLUMNS, { viewport: 1480, available: 1200 });
    expect(machine.view.sort).toEqual({ key: 'due', dir: 'asc' });
    expect(after).toEqual(before);
    expect(machine.view.widths).toBeNull();
  });
});

describe('MP-5-3 facets, presets, modes, chips, reading line, Clear all', () => {
  it('MP-5-3 click replaces shift stacks', () => {
    expect(pressFacet([], 'category:admin', false)).toEqual(['category:admin']);
    expect(pressFacet(['category:admin'], 'category:branding', false)).toEqual([
      'category:branding',
    ]);
    expect(pressFacet(['category:admin'], 'category:branding', true)).toEqual([
      'category:admin',
      'category:branding',
    ]);
    expect(pressFacet(['category:admin', 'category:branding'], 'category:admin', true)).toEqual([
      'category:branding',
    ]);
    // Pressing the only lens off is the way back to everything.
    expect(pressFacet(['category:admin'], 'category:admin', false)).toEqual([]);
  });

  it('MP-5-3 or and and', () => {
    const either = narrowRows(
      ROWS,
      { ids: ['category:admin', 'category:branding'], text: [] },
      FACETS,
      hay,
    );
    expect(byId(either)).toEqual(['r1', 'r2', 'r5']);
    const both = narrowRows(
      ROWS,
      { ids: ['category:branding', 'client:acme-advocacy'], text: [] },
      FACETS,
      hay,
    );
    expect(byId(both)).toEqual(['r1']);
  });

  it('MP-5-3 CS-5.4 filters by one fact of the rows', () => {
    expect(byId(narrowRows(ROWS, { ids: ['client:beta-bakery'], text: [] }, FACETS, hay))).toEqual([
      'r2',
      'r4',
    ]);
  });

  it('MP-5-3 reading line', () => {
    expect(readingLine({ ids: [], text: [] }, FACETS, 5, 0)).toBe('');
    expect(
      readingLine({ ids: ['category:admin', 'category:branding'], text: ['logo'] }, FACETS, 1, 0),
    ).toBe('Reading this as Admin or Branding · the words “logo” — 1 of them');
    expect(readingLine({ ids: ['client:acme-advocacy'], text: [] }, FACETS, 2, 3)).toBe(
      'Reading this as Acme Advocacy — 2 of them · 3 more withheld by permission',
    );
    expect(readingLine({ ids: [], text: [] }, FACETS, 5, 1)).toBe(
      '5 shown · 1 more withheld by permission',
    );
  });

  it('MP-5-3 presets counted', () => {
    expect(presetCount(ROWS, CONTEXT.presets[0] as never, FACETS, hay)).toBe(2);
    const on = reduceBoard(initialMachine(), { type: 'preset', id: 'mine', stack: false }, CONTEXT);
    expect(on.view.ids).toEqual(['category:branding']);
    const off = reduceBoard(on, { type: 'preset', id: 'mine', stack: false }, CONTEXT);
    expect(off.view.ids).toEqual([]);
  });

  it('MP-5-3 modes', () => {
    const on = reduceBoard(initialMachine(), { type: 'mode', id: 'review' }, CONTEXT);
    expect(on.view.mode).toBe('review');
    expect(reduceBoard(on, { type: 'mode', id: 'review' }, CONTEXT).view.mode).toBeNull();
    // An unknown mode is refused, never stored.
    expect(
      reduceBoard(initialMachine(), { type: 'mode', id: 'nope' }, CONTEXT).view.mode,
    ).toBeNull();
  });

  it('MP-5-3 clear all', () => {
    let machine = reduceBoard(initialMachine(), { type: 'commit', raw: 'admin logo' }, CONTEXT);
    expect(machine.view.ids).toEqual(['category:admin']);
    expect(machine.view.text).toEqual(['logo']);
    machine = reduceBoard(machine, { type: 'clear' }, CONTEXT);
    expect(machine.view.ids).toEqual([]);
    expect(machine.view.text).toEqual([]);
    expect(machine.history.past.at(-1)?.label).toBe('clear all');
    // At rest it is a no-op and records no step.
    const rest = reduceBoard(initialMachine(), { type: 'clear' }, CONTEXT);
    expect(rest.history.past).toHaveLength(0);
  });
});

describe('MP-5-4 undo and redo', () => {
  it('MP-5-4 sixty steps', () => {
    let machine = initialMachine();
    const steps: string[] = [];
    for (let index = 0; index < 70; index += 1) {
      const kind = index % 3;
      if (kind === 0) {
        machine = reduceBoard(
          machine,
          { type: 'press', id: 'category:admin', stack: false },
          CONTEXT,
        );
      } else if (kind === 1) {
        machine = reduceBoard(machine, { type: 'sort', key: 'due' }, CONTEXT);
      } else {
        machine = reduceBoard(
          machine,
          {
            type: 'resize',
            key: 'name',
            widths: { name: 400 + index, client: 250, due: 200, cmt: 50, actual: 100 },
          },
          CONTEXT,
        );
      }
      steps.push(machine.history.past.at(-1)?.label ?? '');
    }
    expect(machine.history.past).toHaveLength(HISTORY_CAP);
    expect(HISTORY_CAP).toBe(60);
    for (const step of machine.history.past) expect(step.label).toMatch(/^(filter|sort|resize) /u);
    expect(steps.some((label) => label.startsWith('resize'))).toBe(true);
    const latest = machine.view;
    let back = machine;
    for (let index = 0; index < 60; index += 1) back = reduceBoard(back, { type: 'undo' }, CONTEXT);
    expect(back.history.past).toHaveLength(0);
    expect(reduceBoard(back, { type: 'undo' }, CONTEXT)).toBe(back);
    let forward = back;
    for (let index = 0; index < 60; index += 1)
      forward = reduceBoard(forward, { type: 'redo' }, CONTEXT);
    expect(forward.view).toEqual(latest);
  });

  it('MP-5-4 CS-5.5 steps back and forward through two consecutive changes', () => {
    let machine = reduceBoard(initialMachine(), { type: 'sort', key: 'due' }, CONTEXT);
    machine = reduceBoard(machine, { type: 'press', id: 'category:admin', stack: false }, CONTEXT);
    const undone = reduceBoard(machine, { type: 'undo' }, CONTEXT);
    expect(undone.view.ids).toEqual([]);
    expect(undone.view.sort).toEqual({ key: 'due', dir: 'asc' });
    expect(undone.history.future.at(-1)?.label).toBe('filter Admin');
    const redone = reduceBoard(undone, { type: 'redo' }, CONTEXT);
    expect(redone.view).toEqual(machine.view);
    // A new change after an undo drops the redo branch.
    const branched = reduceBoard(undone, { type: 'sort', key: 'client' }, CONTEXT);
    expect(branched.history.future).toHaveLength(0);
  });
});

describe('MP-5-5 search and typeahead', () => {
  it('MP-5-5 word starts', () => {
    // `ad` starts Admin and Advocacy's words; it is inside no other word here.
    const groups = suggest({
      q: 'ad',
      facets: FACETS,
      names: ROWS.map((row) => row.name),
      noun: 'task',
      have: { ids: [], text: [] },
    });
    const labels = groups.flatMap((group) => group.items.map((item) => item.label));
    expect(labels).toEqual(expect.arrayContaining(['Acme Advocacy', 'Admin', 'Admin audit']));
    // `dmin` is inside Admin, not at a word start: nothing.
    expect(
      suggest({
        q: 'dmin',
        facets: FACETS,
        names: ['Admin audit'],
        noun: 'task',
        have: { ids: [], text: [] },
      }),
    ).toEqual([]);
    // Free words match rows on word starts too.
    expect(byId(narrowRows(ROWS, { ids: [], text: ['ref'] }, FACETS, hay))).toEqual(['r1']);
    expect(byId(narrowRows(ROWS, { ids: [], text: ['efresh'] }, FACETS, hay))).toEqual([]);
  });

  it('MP-5-5 suggestions from two', () => {
    const none = suggest({
      q: 'a',
      facets: FACETS,
      names: [],
      noun: 'task',
      have: { ids: [], text: [] },
    });
    expect(none).toEqual([]);
    const names = Array.from({ length: 8 }, (_, index) => `Brief number ${String(index)}`);
    const groups = suggest({
      q: 'br',
      facets: FACETS,
      names,
      noun: 'task',
      have: { ids: [], text: [] },
    });
    const tasks = groups.find((group) => group.label === 'Tasks');
    expect(tasks?.items).toHaveLength(5);
    expect(tasks?.more).toBe(3);
    expect(groups.every((group) => group.items.length <= 5)).toBe(true);
  });

  it('MP-5-5 facet group visible', () => {
    const names = Array.from({ length: 12 }, (_, index) => `Admin chore ${String(index)}`);
    const groups = suggest({
      q: 'ad',
      facets: FACETS,
      names,
      noun: 'task',
      have: { ids: [], text: [] },
    });
    expect(groups.map((group) => group.label)).toEqual(['Clients', 'Everything else', 'Tasks']);
  });

  it('MP-5-5 commits stack', () => {
    let machine = reduceBoard(initialMachine(), { type: 'commit', raw: 'admin' }, CONTEXT);
    machine = reduceBoard(machine, { type: 'commit', raw: 'branding logo' }, CONTEXT);
    expect(machine.view.ids).toEqual(['category:admin', 'category:branding']);
    expect(machine.view.text).toEqual(['logo']);
    machine = reduceBoard(machine, { type: 'dropLast' }, CONTEXT);
    expect(machine.view.text).toEqual([]);
    machine = reduceBoard(machine, { type: 'dropLast' }, CONTEXT);
    expect(machine.view.ids).toEqual(['category:admin']);
    expect(parseQuery('  Admin  unknownword ', FACETS)).toEqual({
      ids: ['category:admin'],
      text: ['unknownword'],
    });
  });

  it('MP-5-5 search in address', () => {
    const view: BoardView = {
      ids: ['client:acme-advocacy', 'category:admin'],
      text: ['logo', 'q&a=1'],
      sort: { key: 'due', dir: 'desc' },
      mode: 'review',
      widths: null,
    };
    const address = writeView(view);
    expect(readView(address, CONTEXT)).toEqual(view);
    // The same address read again (a reload, or a second person) is the same view.
    expect(readView(`?${address}`, CONTEXT)).toEqual(view);
  });
});

describe('MP-5-3 view in address', () => {
  it('MP-5-3 view in address refuses what the board does not offer', () => {
    const hostile = [
      'f=category%3Aadmin,nope%3Afacet,,',
      'sort=due.sideways',
      'sort=__proto__.asc',
      'mode=%3Cscript%3E',
      'q=%E0%A4%A',
      'f=CATEGORY%3AADMIN',
    ].join('&');
    const view = readView(hostile, CONTEXT);
    expect(view.ids).toEqual(['category:admin']);
    expect(view.sort).toBeNull();
    expect(view.mode).toBeNull();
    expect(view.text).toEqual([]);
    expect(readView('', CONTEXT)).toEqual(initialMachine().view);
  });
});
