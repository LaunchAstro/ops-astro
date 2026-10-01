// SPDX-License-Identifier: AGPL-3.0-only
//
// The page kit's sortable table (CS-9.6) on the kit's table (DS-PRIM-20).
//
// A column sorts on its raw value, never on the text drawn from it: 10 comes
// before 9.5 because it is bigger, not because "1" sorts before "9". The first
// press on a column sorts it descending, a second flips it. Empty cells sit last
// either way, and in a column that mixes kinds the numbers come first. The table
// scrolls inside its own box, so a wide one never widens the page.

import { useState, type ReactElement, type ReactNode } from 'react';
import { Term } from '../kit/marks.tsx';

export type SortValue = string | number | null | undefined;

export interface TableColumn<Row> {
  readonly id: string;
  readonly label: string;
  /** The raw value the column sorts on. */
  readonly value: (row: Row) => SortValue;
  /** What the cell draws; the raw value when absent. */
  readonly render?: ((row: Row) => ReactNode) | undefined;
  readonly numeric?: boolean | undefined;
  /** The plain-words definition of the label, shown on hover and focus. */
  readonly term?: string | undefined;
}

export interface SortState {
  readonly column: string;
  readonly direction: 'asc' | 'desc';
}

export function nextSort(current: SortState | undefined, column: string): SortState {
  if (current?.column === column) {
    return { column, direction: current.direction === 'desc' ? 'asc' : 'desc' };
  }
  return { column, direction: 'desc' };
}

const isEmpty = (value: SortValue): value is null | undefined | '' =>
  value === null || value === undefined || value === '' || Number.isNaN(value);

// Ascending order of two present values: numbers before text, numbers by size,
// text by its letters without regard to case.
function compareRaw(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return a.localeCompare(b, 'en-AU', { sensitivity: 'base', numeric: true });
}

export function sortRows<Row>(
  rows: readonly Row[],
  columns: readonly TableColumn<Row>[],
  sort: SortState | undefined,
): readonly Row[] {
  const column = columns.find((candidate) => candidate.id === sort?.column);
  if (sort === undefined || column === undefined) return rows;
  const sign = sort.direction === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: column.value(row) }))
    .toSorted((a, b) => {
      const aEmpty = isEmpty(a.value);
      const bEmpty = isEmpty(b.value);
      if (aEmpty || bEmpty) return aEmpty === bEmpty ? a.index - b.index : aEmpty ? 1 : -1;
      const order = compareRaw(a.value as string | number, b.value as string | number);
      return order === 0 ? a.index - b.index : sign * order;
    })
    .map((entry) => entry.row);
}

export interface DataTableProps<Row> {
  /** Names the table and its scroll box for a screen reader. */
  readonly label: string;
  readonly columns: readonly TableColumn<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  readonly initialSort?: SortState | undefined;
}

function SortHead(props: {
  readonly id: string;
  readonly label: string;
  readonly term: string | undefined;
  readonly numeric: boolean;
  readonly sorted: 'ascending' | 'descending' | undefined;
  readonly onSort: () => void;
}): ReactElement {
  return (
    <th
      scope="col"
      data-col={props.id}
      className={props.numeric ? 'r' : undefined}
      aria-sort={props.sorted}
    >
      {/* A glossed label sits outside the button, so reading its tip never sorts. */}
      {props.term === undefined ? (
        <button type="button" className="table__sort" onClick={props.onSort}>
          {props.label}
          <span className="table__arrow" aria-hidden="true">
            {props.sorted === 'ascending' ? '↑' : '↓'}
          </span>
        </button>
      ) : (
        <>
          <Term tip={props.term}>{props.label}</Term>
          <button
            type="button"
            className="table__sort"
            aria-label={`Sort by ${props.label}`}
            onClick={props.onSort}
          >
            <span className="table__arrow" aria-hidden="true">
              {props.sorted === 'ascending' ? '↑' : '↓'}
            </span>
          </button>
        </>
      )}
    </th>
  );
}

export function DataTable<Row>(props: DataTableProps<Row>): ReactElement {
  const [sort, setSort] = useState<SortState | undefined>(props.initialSort);
  const sorted = sortRows(props.rows, props.columns, sort);
  const ariaSort = (id: string): 'ascending' | 'descending' | undefined => {
    if (sort?.column === id) return sort.direction === 'asc' ? 'ascending' : 'descending';
    return undefined;
  };
  return (
    // A focusable region, so a keyboard can scroll a table wider than its box.
    <div className="tablewrap tbl-box" role="region" aria-label={props.label} tabIndex={0}>
      <table className="table">
        <caption className="visually-hidden">{props.label}</caption>
        <thead>
          <tr>
            {props.columns.map((column) => (
              <SortHead
                key={column.id}
                id={column.id}
                label={column.label}
                term={column.term}
                numeric={column.numeric === true}
                sorted={ariaSort(column.id)}
                onSort={() => setSort((current) => nextSort(current, column.id))}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={props.rowKey(row)}>
              {props.columns.map((column) => (
                <td key={column.id} className={column.numeric === true ? 'r' : undefined}>
                  {column.render === undefined ? (column.value(row) ?? '') : column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
