// SPDX-License-Identifier: AGPL-3.0-only
//
// The sort cycle (MP-5-2, B-15, CS-5.7): the first press lands on the
// column's useful direction, the second reverses it, the third puts the
// board back in its own order. Blanks sort last in either direction, so
// reversing a due column never brings the undated tasks to the top.

import type { ColumnSpec, SortDir, SortState } from './types.ts';

const firstDirOf = <Row>(column: ColumnSpec<Row>): SortDir =>
  column.firstDir ?? (column.align === 'end' ? 'desc' : 'asc');

/** What one press on this column's head does to the current sort. */
export function nextSort<Row>(
  current: SortState | null,
  column: ColumnSpec<Row>,
): SortState | null {
  const first = firstDirOf(column);
  if (current === null || current.key !== column.key) return { key: column.key, dir: first };
  if (current.dir === first) return { key: column.key, dir: first === 'asc' ? 'desc' : 'asc' };
  return null;
}

/** The rows in the sort's order; a stable sort, so ties keep the board's order. */
export function sortRows<Row>(
  rows: readonly Row[],
  sort: SortState | null,
  columns: readonly ColumnSpec<Row>[],
): readonly Row[] {
  if (sort === null) return rows;
  const value = columns.find((column) => column.key === sort.key)?.sortValue;
  if (value === undefined) return rows;
  const direction = sort.dir === 'asc' ? 1 : -1;
  return rows.toSorted((left, right) => {
    const a = value(left);
    const b = value(right);
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    const order =
      typeof a === 'number' && typeof b === 'number'
        ? a - b
        : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
    return order * direction;
  });
}
