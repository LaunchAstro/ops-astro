// SPDX-License-Identifier: AGPL-3.0-only
//
// S1: the projects board, at `/projects/`.
//
// **It is a table, not a card board**, and the columns below are the pinned
// mockup's own `COLS` with their labels and their percentage widths carried
// across (`assets/projectsboard.js:711`). Rows are grouped by status with a
// plain banner: no colour and no count, because a board where every row shouts
// says nothing.
//
// What is deliberately NOT ported: the facet menu, presets, undo and redo,
// typeahead, column drag-resize and the review-queue cards. The candidate's own
// rule is to start with the components the first slice actually uses and not to
// bulk-import a component estate to build one screen. The filter row draws the
// filters that are on, because "board default and filtered" is one of the
// captures the visual acceptance set requires.

import type { ReactElement } from 'react';
import { Empty } from '../primitives/Absence.tsx';
import { Spill } from '../primitives/Status.tsx';
import type { DrawnState } from '../state/project.ts';

/** One column of the board, as the pinned sheet declares it. */
export interface BoardColumn {
  readonly key: string;
  readonly label: string;
  /** Share of the table's width, from the pinned `COLS`. */
  readonly pct: number;
  /** Below this width the column is not drawn at all. */
  readonly hideBelow?: number;
}

export const BOARD_COLUMNS: readonly BoardColumn[] = [
  { key: 'rank', label: 'Rank', pct: 2 },
  { key: 'name', label: 'Task name', pct: 28.5 },
  { key: 'client', label: 'Client', pct: 13.5 },
  { key: 'assignee', label: 'Assignee', pct: 11 },
  { key: 'due', label: 'Due date', pct: 12 },
  { key: 'stage', label: 'Stage', pct: 8.45, hideBelow: 900 },
  { key: 'state', label: 'State', pct: 12 },
  { key: 'estimate', label: 'Estimates', pct: 2, hideBelow: 1280 },
  { key: 'actual', label: 'Actual', pct: 9.5, hideBelow: 1280 },
];

export interface BoardRow {
  readonly id: string;
  /** Absent until the row has joined the ordering; a dash, never a zero. */
  readonly rank: number | null;
  readonly name: string;
  readonly client: string | null;
  readonly assignee: string | null;
  readonly dueLabel: string | null;
  readonly due: 'past' | 'today' | 'later' | null;
  readonly stage: string | null;
  readonly state: DrawnState;
  readonly estimate: string | null;
  readonly actual: string | null;
  /** The status word the rows group under. */
  readonly group: string;
  readonly href: string;
}

export interface BoardFilter {
  readonly kind: string;
  readonly label: string;
}

export interface BoardProps {
  readonly rows: readonly BoardRow[];
  /** In declared order, so the group banners are the installation's own. */
  readonly groups: readonly string[];
  readonly filters: readonly BoardFilter[];
  readonly onDropFilter?: (kind: string) => void;
}

export function Board(props: BoardProps): ReactElement {
  const columns = BOARD_COLUMNS;
  return (
    <div className="cbd">
      <div className="cbd__filters">
        <span className="cbd__flabel">Filter</span>
        {props.filters.length === 0 ? (
          <span className="cbd__tag">
            <span className="cbd__tagk">none</span> every task
          </span>
        ) : (
          props.filters.map((filter) => (
            <span className="cbd__tag" key={filter.kind}>
              <span className="cbd__tagk">{filter.kind}</span>
              {filter.label}
              {props.onDropFilter === undefined ? null : (
                <button
                  className="cbd__tagx"
                  type="button"
                  aria-label={`Drop the ${filter.kind} filter`}
                  onClick={() => {
                    props.onDropFilter?.(filter.kind);
                  }}
                >
                  ×
                </button>
              )}
            </span>
          ))
        )}
      </div>

      {props.rows.length === 0 ? (
        <div className="cbd__empty">
          <Empty title="No task matches that." description="Drop a filter to widen the list." />
        </div>
      ) : (
        <div className="cbd__wrap">
          <table className="cbd__tbl">
            <colgroup>
              {columns.map((column) => (
                <col key={column.key} style={{ width: `${column.pct.toFixed(4)}%` }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.key} data-hide-below={column.hideBelow ?? undefined}>
                    <span className="cbd__th">
                      <span className="cbd__thl">{column.label}</span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {props.groups.flatMap((group) => {
                const rows = props.rows.filter((row) => row.group === group);
                if (rows.length === 0) return [];
                return [
                  <tr className="cbd__grp" key={`group-${group}`}>
                    <td colSpan={columns.length}>
                      <span className="cbd__grpb">{group}</span>
                    </td>
                  </tr>,
                  ...rows.map((row) => <Row key={row.id} row={row} />),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row(props: { readonly row: BoardRow }): ReactElement {
  const row = props.row;
  return (
    <tr data-taskrow={row.id}>
      <td>
        {row.rank === null ? (
          <span className="cbd__dim" title="Not ranked yet — it is in the review queue">
            —
          </span>
        ) : (
          <span className="cbd__rank">{row.rank}</span>
        )}
      </td>
      <td>
        <div className="cbd__name">
          <a className="cbd__nm" href={row.href}>
            {row.name}
          </a>
        </div>
      </td>
      <td>{row.client ?? <span className="cbd__dim">—</span>}</td>
      <td>
        {row.assignee === null ? (
          <span className="cbd__dim">Unassigned</span>
        ) : (
          <div className="cbd__name">
            <span className="cbd__av" aria-hidden="true">
              {initials(row.assignee)}
            </span>
            <span className="cbd__nm">{row.assignee}</span>
          </div>
        )}
      </td>
      <td>
        <Due row={row} />
      </td>
      <td data-hide-below={900}>{row.stage ?? <span className="cbd__dim">—</span>}</td>
      <td>
        <Spill state={row.state} />
      </td>
      <td data-hide-below={1280}>{row.estimate ?? <span className="cbd__dim">—</span>}</td>
      <td data-hide-below={1280}>{row.actual ?? <span className="cbd__dim">—</span>}</td>
    </tr>
  );
}

function Due(props: { readonly row: BoardRow }): ReactElement {
  const { due, dueLabel } = props.row;
  if (dueLabel === null) return <span className="cbd__dim">—</span>;
  if (due === 'past') {
    return <span className="tl__due is-bad is-now">Overdue · {dueLabel}</span>;
  }
  if (due === 'today') return <span className="tl__due is-now">Today</span>;
  return <span className="tl__due">{dueLabel}</span>;
}

const initials = (name: string): string =>
  name
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join('');
