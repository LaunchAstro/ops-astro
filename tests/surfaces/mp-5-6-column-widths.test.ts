// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-6 (U13), the parts that are pure: the drag that moves width between a
// column and those to its right (B-17), the view history's one step per drag
// and per reset (B-13), the keyboard step, the layout drawn from a person's
// widths, and the widths as one key of the one preference store (FG-O-5).
// What needs a document is in `mp-5-6-7-board-dom.test.tsx`; the store's own
// legs (own row only, no audit, separation) wait on MP-2-11 and are in the
// handback.

import { describe, expect, it } from 'vitest';
import {
  GRIP_STEP,
  GRIP_STEP_LARGE,
  WIDTHS_PREFERENCE,
  initialMachine,
  layoutColumns,
  reduceBoard,
  resizeAt,
  widthsAfterDrag,
  widthsFromPreference,
  widthsToPreference,
  type BoardContext,
  type ColumnSpec,
  type ColumnWidths,
} from '../../packages/ui/src/board/index.ts';

interface Row {
  readonly id: string;
}

const column = (
  key: string,
  label: string,
  share: number,
  min: number,
  extra: Partial<ColumnSpec<Row>> = {},
): ColumnSpec<Row> => ({ key, label, share, min, labelWidth: 0, align: 'start', ...extra });

// At 1000px and a 1480 viewport the defaults draw 400, 250, 200, 50 and 100.
const COLUMNS: readonly ColumnSpec<Row>[] = [
  column('name', 'Task name', 40, 140),
  column('client', 'Client', 25, 90),
  column('due', 'Due date', 20, 64),
  column('cmt', 'Client comments', 5, 36),
  column('actual', 'Actual', 10, 56, { hideBelow: 900 }),
];

const CONTEXT: BoardContext<Row> = { facets: [], columns: COLUMNS, presets: [], modes: [] };
const WIDE = { viewport: 1480, available: 1000 };
const px = (widths: readonly number[]): readonly number[] => widths.map((w) => Math.round(w));
const sum = (widths: readonly number[]): number => widths.reduce((total, w) => total + w, 0);

describe('MP-5-6 drag within minimums', () => {
  const start = [400, 250, 200, 50, 100];

  it('a drag wider takes width from the columns to its right, in proportion to their slack', () => {
    const after = resizeAt(COLUMNS, start, 1, 60);
    expect(after[0]).toBe(400);
    expect(after[1]).toBe(310);
    expect(sum(after)).toBe(1000);
    // due has 136 of slack, cmt 14, actual 44: due gives the most, cmt the least.
    const given = [200, 50, 100].map((was, index) => was - (after[index + 2] ?? 0));
    expect(given[0]).toBeGreaterThan(given[2] ?? 0);
    expect(given[2]).toBeGreaterThan(given[1] ?? 0);
  });

  it('the columns give exactly the drag, in whole pixels, however the shares round', () => {
    const even = [{ min: 10 }, { min: 10 }, { min: 10 }, { min: 10 }];
    for (const dx of [1, 2, 5, 29, 30]) {
      const after = resizeAt(even, [100, 20, 20, 20], 0, dx);
      expect(after[0]).toBe(100 + dx);
      expect(sum(after)).toBe(160);
      after.forEach((width) => {
        expect(Number.isInteger(width)).toBe(true);
      });
    }
  });

  it('a drag past the room stops with every column to the right at its floor', () => {
    const after = resizeAt(COLUMNS, start, 0, 1000);
    expect(after).toEqual([754, 90, 64, 36, 56]);
  });

  it('a drag narrower gives to the next column only, and stops at its own floor', () => {
    const after = resizeAt(COLUMNS, start, 1, -300);
    expect(after).toEqual([400, 90, 360, 50, 100]);
  });

  it('never moves a column to the left of the grip, and the last column has no grip', () => {
    for (const dx of [-500, -7, 7, 500]) {
      for (let index = 0; index < start.length; index += 1) {
        const after = resizeAt(COLUMNS, start, index, dx);
        expect(after.slice(0, index)).toEqual(start.slice(0, index));
        expect(sum(after)).toBe(1000);
        after.forEach((width, at) => {
          expect(width).toBeGreaterThanOrEqual(COLUMNS[at]?.min ?? 0);
        });
      }
    }
    expect(resizeAt(COLUMNS, start, 4, 50)).toEqual(start);
    expect(resizeAt(COLUMNS, start, -1, 50)).toEqual(start);
  });

  it('a drag of nothing, or one that only rounds to nothing, changes no width', () => {
    const layout = layoutColumns(COLUMNS, WIDE);
    expect(widthsAfterDrag(COLUMNS, layout, null, 'client', 0)).toBeNull();
    expect(widthsAfterDrag(COLUMNS, layout, null, 'client', 0.4)).toBeNull();
    // Already at its floor: narrower moves nothing.
    const floored = { name: 400, client: 90, due: 360, cmt: 50, actual: 100 };
    const tight = layoutColumns(COLUMNS, WIDE, floored);
    expect(widthsAfterDrag(COLUMNS, tight, floored, 'client', -GRIP_STEP)).toBeNull();
  });
});

describe('MP-5-6 one undo per drag', () => {
  const layout = layoutColumns(COLUMNS, WIDE);

  it('a finished drag is one step, named after its column, and Undo returns the defaults', () => {
    const widths = widthsAfterDrag(COLUMNS, layout, null, 'client', 120);
    expect(widths).not.toBeNull();
    const dragged = reduceBoard(
      initialMachine(),
      { type: 'resize', key: 'client', widths: widths as ColumnWidths },
      CONTEXT,
    );
    expect(dragged.history.past).toHaveLength(1);
    expect(dragged.history.past[0]?.label).toBe('resize Client');
    expect(dragged.view.widths).toEqual(widths);
    const undone = reduceBoard(dragged, { type: 'undo' }, CONTEXT);
    expect(undone.view.widths).toBeNull();
    expect(reduceBoard(undone, { type: 'redo' }, CONTEXT).view.widths).toEqual(widths);
  });

  it('widths the board does not draw, or no store could keep, record nothing', () => {
    const at = initialMachine();
    const refused: readonly ColumnWidths[] = [
      {},
      { name: 400, ghost: 100 },
      { name: 0 },
      { name: -4 },
      { name: 10.5 },
      { name: Number.NaN },
      { name: Number.POSITIVE_INFINITY },
      { name: 10_001 },
      JSON.parse('{"__proto__": 300}') as ColumnWidths,
    ];
    for (const widths of refused) {
      expect(reduceBoard(at, { type: 'resize', key: 'name', widths }, CONTEXT)).toBe(at);
    }
    expect(reduceBoard(at, { type: 'resize', key: 'ghost', widths: { name: 400 } }, CONTEXT)).toBe(
      at,
    );
  });
});

describe('MP-5-6 reset', () => {
  it('Reset columns returns the defaults as one step, and Undo brings the widths back', () => {
    const widths = { name: 300, client: 350, due: 200, cmt: 50, actual: 100 };
    const dragged = reduceBoard(initialMachine(), { type: 'resize', key: 'name', widths }, CONTEXT);
    const reset = reduceBoard(dragged, { type: 'resetWidths' }, CONTEXT);
    expect(reset.view.widths).toBeNull();
    expect(reset.history.past.at(-1)?.label).toBe('reset columns');
    expect(reduceBoard(reset, { type: 'undo' }, CONTEXT).view.widths).toEqual(widths);
  });

  it('at the defaults there is nothing to reset and nothing is recorded', () => {
    const rest = initialMachine();
    expect(reduceBoard(rest, { type: 'resetWidths' }, CONTEXT)).toBe(rest);
  });
});

describe('MP-5-6 keyboard resize', () => {
  it('an arrow step is a drag of the step, one undo step each, Shift a larger one', () => {
    expect(GRIP_STEP).toBe(16);
    expect(GRIP_STEP_LARGE).toBe(64);
    const layout = layoutColumns(COLUMNS, WIDE);
    const right = widthsAfterDrag(COLUMNS, layout, null, 'client', GRIP_STEP);
    expect(right?.['client']).toBe(266);
    const left = widthsAfterDrag(COLUMNS, layout, null, 'client', -GRIP_STEP_LARGE);
    expect(left?.['client']).toBe(186);
    expect(left?.['due']).toBe(264);
  });
});

describe('MP-5-6 the layout draws the person’s widths', () => {
  it('widths are relative: the shares follow them at any card width, floors honoured', () => {
    const widths = { name: 300, client: 300, due: 200, cmt: 100, actual: 100 };
    const laid = layoutColumns(COLUMNS, WIDE, widths);
    expect(px(laid.columns.map((one) => one.px))).toEqual([300, 300, 200, 100, 100]);
    const half = layoutColumns(COLUMNS, { viewport: 1480, available: 500 }, widths);
    const halfPx = half.columns.map((one) => one.px);
    halfPx.forEach((width, at) => {
      expect(width).toBeGreaterThanOrEqual((COLUMNS[at]?.min ?? 0) - 0.01);
    });
    expect(Math.round(sum(halfPx))).toBe(500);
  });

  it('a hidden column drops and the survivors keep their proportions', () => {
    const widths = { name: 300, client: 300, due: 200, cmt: 100, actual: 100 };
    const narrow = layoutColumns(COLUMNS, { viewport: 800, available: 900 }, widths);
    expect(narrow.columns.map((one) => one.key)).toEqual(['name', 'client', 'due', 'cmt']);
    expect(px(narrow.columns.map((one) => one.px))).toEqual([300, 300, 200, 100]);
  });

  it('widths that miss a drawn column fall back to the board’s defaults', () => {
    const partial = { name: 700, client: 100 };
    expect(layoutColumns(COLUMNS, WIDE, partial)).toEqual(layoutColumns(COLUMNS, WIDE));
    expect(layoutColumns(COLUMNS, WIDE, null)).toEqual(layoutColumns(COLUMNS, WIDE));
  });

  it('a drag keeps the widths of columns this viewport does not draw', () => {
    const before = { name: 300, client: 300, due: 200, cmt: 100, actual: 150 };
    const narrow = layoutColumns(COLUMNS, { viewport: 800, available: 900 }, before);
    const after = widthsAfterDrag(COLUMNS, narrow, before, 'name', 30);
    expect(after?.['actual']).toBe(150);
    expect(after?.['name']).toBe(330);
  });
});

describe('MP-5-6 widths in one store', () => {
  it('the widths are the one store’s columns.widths key, each board under its own name', () => {
    expect(WIDTHS_PREFERENCE).toBe('columns.widths');
    const stored = { 'clients.name': 240, 'clients.status': 120 };
    const saved = widthsToPreference('projects', stored, { name: 300, client: 200 });
    expect(saved).toEqual({
      'clients.name': 240,
      'clients.status': 120,
      'projects.name': 300,
      'projects.client': 200,
    });
    expect(widthsFromPreference('projects', COLUMNS, saved)).toEqual({ name: 300, client: 200 });
    expect(widthsFromPreference('clients', COLUMNS, saved)).toEqual({ name: 240 });
  });

  it('a reset removes this board’s widths and leaves every other board’s', () => {
    const stored = { 'clients.name': 240, 'projects.name': 300, 'projects.client': 200 };
    expect(widthsToPreference('projects', stored, null)).toEqual({ 'clients.name': 240 });
  });

  it('nothing saved, or nothing usable saved, is the defaults', () => {
    for (const stored of [
      undefined,
      null,
      'projects.name',
      42,
      [300, 200],
      {},
      { 'projects.ghost': 300 },
      { name: 300 },
      { 'projects.name': '300' },
      { 'projects.name': -1 },
      { 'projects.name': 2.5 },
      { 'projects.name': 99_999 },
      JSON.parse('{"__proto__": {"projects.name": 300}}') as unknown,
    ]) {
      expect(widthsFromPreference('projects', COLUMNS, stored)).toBeNull();
    }
    expect(widthsToPreference('projects', [1, 2], { name: 300 })).toEqual({ 'projects.name': 300 });
    expect(widthsToPreference('projects', 'junk', null)).toEqual({});
  });

  it('a usable width survives beside a hostile one', () => {
    const stored = { 'projects.name': 300, 'projects.client': 'wide', 'projects.due': 1e9 };
    expect(widthsFromPreference('projects', COLUMNS, stored)).toEqual({ name: 300 });
  });
});
