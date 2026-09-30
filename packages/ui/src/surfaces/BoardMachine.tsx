// SPDX-License-Identifier: AGPL-3.0-only
//
// The board machine drawn (U09 and U13, DS-COMP-16 and DS-COMP-17): the
// command bar (search, the funnel menu of every filter, Reset columns, undo,
// redo, Clear all and the freshness stamp), the chip row (presets, modes and a
// tag chip for every filter the row cannot show), the reading line, and the
// table laid out by the width model with sortable, keyboard-operable heads and
// resize grips. A mode swaps the table for its own surface over the same rows,
// or narrows the table to some of them.
// The command bar is drawn into the page's title row when the page hands one
// over, and leaves it whenever the board is not the panel showing (D-03). The
// chip row and the heads stick under the chrome; the board publishes the chip
// row's height as `--catbar-h` for the heads' offset.
//
// It draws only the rows it is handed, which are the rows the viewer may
// read; the withheld count arrives as a number and is only ever printed.
// Everything a person changes here is view state: it goes through the
// machine's history and into the address, and never writes a record. Column
// widths (MP-5-6) go through the history too, but not into the address: they
// are the person's own, handed out through `onWidths` for the one store.

import { useMemo, useRef, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Empty } from '../primitives/Absence.tsx';
import { rankFacets } from '../board/funnel.ts';
import { narrowRows, readingLine } from '../board/filters.ts';
import { sortRows } from '../board/sort.ts';
import type { BoardAction, BoardContext, BoardView } from '../board/types.ts';
import type { BoardMachineProps } from './board-props.ts';
import {
  useBoardMachine,
  useChipRowFit,
  useColumnDrag,
  useFunnelMenu,
  useMeasuredWidth,
} from './board-hooks.ts';
import { ChipRow } from './BoardChips.tsx';
import { CommandBar } from './BoardCommandBar.tsx';
import { Table } from './BoardTable.tsx';

export type { BoardMachineProps, BoardMode } from './board-props.ts';

export function BoardMachine<Row>(props: BoardMachineProps<Row>): ReactElement {
  const { facets, columns, presets, modes } = props;
  const context = useMemo<BoardContext<Row>>(
    () => ({ facets, columns, presets: presets ?? [], modes: modes ?? [] }),
    [facets, columns, presets, modes],
  );
  // Every filter's row count, once per set of rows: a drag redraws on each
  // pointer move and must not recount.
  const ranked = useMemo(() => rankFacets(props.rows, props.facets), [props.rows, props.facets]);
  const { machine, dispatch } = useBoardMachine(context, props, props);
  const card = useRef<HTMLDivElement>(null);
  const available = useMeasuredWidth(card, props.width);
  const viewport =
    props.viewport ?? (typeof window === 'undefined' ? available : window.innerWidth);
  const drag = useColumnDrag(props.columns, { viewport, available }, machine.view.widths, dispatch);
  const menu = useFunnelMenu();
  const chipRow = useRef<HTMLDivElement>(null);
  useChipRowFit(chipRow, card);
  const command = (
    <CommandBar
      facets={props.facets}
      names={props.rows.map((row) => props.name(row))}
      noun={props.noun}
      machine={machine}
      ranked={ranked}
      presets={props.presets ?? []}
      menu={menu}
      changedAt={props.changedAt ?? null}
      now={props.now ?? new Date()}
      dispatch={dispatch}
    />
  );
  const bar = props.hidden === true ? null : props.bar ? createPortal(command, props.bar) : command;
  return (
    <div className="cbd" data-board="" ref={card} hidden={props.hidden === true}>
      {bar}
      <ChipRow
        chipRow={chipRow}
        rows={props.rows}
        presets={props.presets ?? []}
        modes={props.modes ?? []}
        facets={props.facets}
        hay={props.hay}
        view={machine.view}
        dispatch={dispatch}
      />
      <BoardBody {...props} view={machine.view} drag={drag} dispatch={dispatch} />
    </div>
  );
}

/** The reading line, then the mode's own surface, the empty state or the table. */
function BoardBody<Row>(
  props: BoardMachineProps<Row> & {
    readonly view: BoardView;
    readonly drag: ReturnType<typeof useColumnDrag<Row>>;
    readonly dispatch: (action: BoardAction) => void;
  },
): ReactElement {
  const { view, drag, dispatch } = props;
  const narrowed = narrowRows(props.rows, view, props.facets, props.hay);
  const mode = (props.modes ?? []).find((one) => one.id === view.mode);
  const keep = mode?.narrow;
  const moded = keep === undefined ? narrowed : narrowed.filter((row) => keep(row));
  const sorted = sortRows(moded, view.sort, props.columns);
  const line = readingLine(view, props.facets, narrowed.length, props.withheld);
  const surface = mode?.render;
  const empty = mode?.empty ?? props.empty;
  return (
    <>
      {line === '' ? null : <p className="cbd__read">{line}</p>}
      {surface ? (
        surface(narrowed)
      ) : sorted.length === 0 ? (
        <div className="cbd__empty">
          <Empty title={empty.title} description={empty.description} />
        </div>
      ) : (
        <Table
          layout={drag.layout.columns}
          tableWidth={drag.layout.tableWidth}
          columns={props.columns}
          rows={sorted}
          sort={view.sort}
          groups={props.groups}
          rowKey={props.rowKey}
          cell={props.cell}
          onSort={(key) => {
            dispatch({ type: 'sort', key });
          }}
          grip={{ live: drag.live?.key ?? null, start: drag.start, nudge: drag.nudge }}
        />
      )}
    </>
  );
}
