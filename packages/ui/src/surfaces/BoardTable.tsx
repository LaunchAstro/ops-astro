// SPDX-License-Identifier: AGPL-3.0-only
//
// The board machine's table (U09 and U13, DS-COMP-17): laid out by the width
// model, with sortable, keyboard-operable heads and a resize grip between
// each pair of heads (MP-5-6), and rows under group banners when the board
// groups them (MP-5-11).

import type { ReactElement, ReactNode } from 'react';
import { GRIP_STEP, GRIP_STEP_LARGE } from '../board/widths.ts';
import type { ColumnSpec, LaidColumn } from '../board/types.ts';
import { GLYPH, type BoardMachineProps } from './board-props.ts';

type Sort = { readonly key: string; readonly dir: 'asc' | 'desc' } | null;

interface Grip {
  readonly live: string | null;
  readonly start: (key: string, clientX: number) => void;
  readonly nudge: (key: string, dx: number) => void;
}

interface Drawn<Row> {
  readonly layout: readonly LaidColumn[];
  readonly rows: readonly Row[];
  readonly groups: BoardMachineProps<Row>['groups'];
  readonly rowKey: (row: Row) => string;
  readonly cell: (row: Row, key: string) => ReactNode;
}

export function Table<Row>(
  props: Drawn<Row> & {
    readonly tableWidth: number | null;
    readonly columns: readonly ColumnSpec<Row>[];
    readonly sort: Sort;
    readonly onSort: (key: string) => void;
    readonly grip: Grip;
  },
): ReactElement {
  const width = props.tableWidth;
  return (
    <div className="cbd__wrap">
      <table
        className="cbd__tbl"
        style={
          width === null
            ? undefined
            : { width: `${String(width)}px`, minWidth: `${String(width)}px` }
        }
      >
        <colgroup>
          {props.layout.map((column) => (
            <col key={column.key} style={{ width: `${column.pct.toFixed(4)}%` }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {props.layout.map((column, index) => (
              <HeadCell
                key={column.key}
                column={column}
                spec={props.columns.find((one) => one.key === column.key)}
                sort={props.sort}
                last={index === props.layout.length - 1}
                onSort={props.onSort}
                grip={props.grip}
              />
            ))}
          </tr>
        </thead>
        <tbody>{bodyRows(props)}</tbody>
      </table>
    </div>
  );
}

/** The rows in order, under a banner for each group that has any when the board groups them. */
function bodyRows<Row>(props: Drawn<Row>): ReactElement[] {
  const drawRow = (row: Row): ReactElement => (
    <tr key={props.rowKey(row)} data-row={props.rowKey(row)}>
      {props.layout.map((column) => (
        <td
          key={column.key}
          data-key={column.key}
          data-align={column.align}
          data-tight={column.tight ? '' : undefined}
        >
          {props.cell(row, column.key)}
        </td>
      ))}
    </tr>
  );
  const grouped = props.groups;
  if (grouped === undefined) return props.rows.map((row) => drawRow(row));
  const seen = [...new Set(props.rows.map((row) => grouped.of(row)))];
  const order = [...grouped.order, ...seen.filter((group) => !grouped.order.includes(group))];
  return order.flatMap((group) => {
    const rows = props.rows.filter((row) => grouped.of(row) === group);
    if (rows.length === 0) return [];
    const reason = grouped.reason?.(rows) ?? null;
    const drawn: ReactElement[] = [
      <tr className="cbd__grp" key={`group:${group}`}>
        <td colSpan={props.layout.length}>
          <span className="cbd__grpb">
            {group}
            {reason === null ? null : <span className="cbd__grpr">{reason}</span>}
          </span>
        </td>
      </tr>,
    ];
    for (const row of rows) drawn.push(drawRow(row));
    return drawn;
  });
}

function HeadCell<Row>(props: {
  readonly column: LaidColumn;
  readonly spec: ColumnSpec<Row> | undefined;
  readonly sort: Sort;
  readonly last: boolean;
  readonly onSort: (key: string) => void;
  readonly grip: Grip;
}): ReactElement {
  const { column, spec } = props;
  const label = spec?.label ?? column.key;
  const sorted = props.sort?.key === column.key ? props.sort.dir : undefined;
  return (
    <th
      data-key={column.key}
      data-align={column.align}
      data-tight={column.tight ? '' : undefined}
      aria-sort={sorted === undefined ? 'none' : sorted === 'asc' ? 'ascending' : 'descending'}
    >
      <HeadInner
        label={label}
        icon={spec?.icon}
        tight={column.tight}
        sorted={sorted}
        sortable={spec?.sortValue !== undefined}
        onSort={() => {
          props.onSort(column.key);
        }}
      />
      {props.last ? null : (
        <GripHandle column={column} label={label} min={spec?.min ?? 0} grip={props.grip} />
      )}
    </th>
  );
}

/** The resize grip after a head: dragged, or stepped with the arrow keys (MP-5-6). */
function GripHandle(props: {
  readonly column: LaidColumn;
  readonly label: string;
  readonly min: number;
  readonly grip: Grip;
}): ReactElement {
  const { column, grip } = props;
  return (
    <span
      className={`cbd__grip${grip.live === column.key ? ' is-live' : ''}`}
      data-grip={column.key}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${props.label}`}
      aria-valuenow={Math.round(column.px)}
      aria-valuemin={props.min}
      tabIndex={0}
      title="Drag, or use the arrow keys, to resize"
      onPointerDown={(event) => {
        event.preventDefault();
        grip.start(column.key, event.clientX);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        const step = event.shiftKey ? GRIP_STEP_LARGE : GRIP_STEP;
        grip.nudge(column.key, event.key === 'ArrowRight' ? step : -step);
      }}
    />
  );
}

function HeadInner(props: {
  readonly label: string;
  readonly icon: string | undefined;
  readonly tight: boolean;
  readonly sorted: 'asc' | 'desc' | undefined;
  readonly sortable: boolean;
  readonly onSort: () => void;
}): ReactElement {
  const inner = (
    <>
      {props.icon === undefined ? null : (
        <span className="cbd__thi" data-icon={props.icon} aria-hidden="true">
          {GLYPH[props.icon] ?? '•'}
        </span>
      )}
      <span className="cbd__thl">{props.label}</span>
      {props.sorted === undefined ? null : (
        <span className="cbd__arrow" aria-hidden="true">
          {props.sorted === 'asc' ? '▲' : '▼'}
        </span>
      )}
    </>
  );
  if (!props.sortable) {
    return (
      <span className="cbd__th" aria-label={props.tight ? props.label : undefined}>
        {inner}
      </span>
    );
  }
  return (
    <button
      className="cbd__th"
      type="button"
      title={`Sort by ${props.label}`}
      aria-label={props.tight ? props.label : undefined}
      onClick={props.onSort}
    >
      {inner}
    </button>
  );
}
