// SPDX-License-Identifier: AGPL-3.0-only
//
// The board machine drawn (U09 and U13, DS-COMP-16 and DS-COMP-17): the
// command bar (search, the funnel menu of every filter, Reset columns, undo,
// redo, Clear all and the freshness stamp), the chip row (presets, modes and a
// tag chip for every filter the row cannot show), the reading line, and the
// table laid out by the width model with sortable, keyboard-operable heads and
// resize grips. A mode swaps the table for its own surface over the same rows.
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

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Empty } from '../primitives/Absence.tsx';
import { layoutColumns } from '../board/columns.ts';
import { GRIP_STEP, GRIP_STEP_LARGE, widthsAfterDrag } from '../board/widths.ts';
import {
  FUNNEL_FIRST,
  fitChipRow,
  freshness,
  funnelMenu,
  hiddenFilters,
  rankFacets,
  type ChipTier,
} from '../board/funnel.ts';
import { narrowRows, presetCount, readingLine } from '../board/filters.ts';
import { initialMachine, reduceBoard } from '../board/machine.ts';
import { sortRows } from '../board/sort.ts';
import { readView, writeView } from '../board/address.ts';
import type {
  BoardAction,
  BoardContext,
  ColumnSpec,
  ColumnWidths,
  Facet,
  LaidColumn,
  MachineState,
  Mode,
  Preset,
} from '../board/types.ts';
import { BoardSearch } from './BoardSearch.tsx';

export interface BoardMode<Row> extends Mode {
  /** The alternative surface, over the same narrowed rows. */
  readonly render: (rows: readonly Row[]) => ReactNode;
}

export interface BoardMachineProps<Row> {
  /** The rows the viewer may read, as the board's read answered them. */
  readonly rows: readonly Row[];
  /** How many rows the viewer's grants withheld, never which (B-22). */
  readonly withheld: number;
  readonly columns: readonly ColumnSpec<Row>[];
  readonly facets: readonly Facet<Row>[];
  readonly presets?: readonly Preset[];
  readonly modes?: readonly BoardMode<Row>[];
  /** Rows grouped under banners in this order; sorting happens within groups. */
  readonly groups?: { readonly order: readonly string[]; readonly of: (row: Row) => string };
  readonly rowKey: (row: Row) => string;
  readonly cell: (row: Row, key: string) => ReactNode;
  /** What a free word is matched against. */
  readonly hay: (row: Row) => string;
  /** The row's name, as the typeahead suggests it. */
  readonly name: (row: Row) => string;
  readonly noun: string;
  readonly empty: { readonly title: string; readonly description: string };
  /** The address's query the board opens on (B-06, C6). */
  readonly address?: string;
  /** Told the new query whenever the view changes. */
  readonly onAddress?: (address: string) => void;
  /** The card's width in pixels; measured when absent. */
  readonly width?: number;
  /** The window's width, for `hideBelow`; read from the window when absent. */
  readonly viewport?: number;
  /** The person's saved column widths the board opens on (MP-5-6); null is the defaults. */
  readonly widths?: ColumnWidths | null;
  /** Told the widths to keep whenever a drag, an arrow step, a reset or an undo changes them. */
  readonly onWidths?: (widths: ColumnWidths | null) => void;
  /** When the newest record in scope changed (MP-5-7, P-07); null or absent draws no stamp. */
  readonly changedAt?: string | null;
  /** The time the stamp counts from; the clock when absent. */
  readonly now?: Date;
  /** The page's title-row slot the command bar is drawn into (MP-5-7, B-04). */
  readonly bar?: HTMLElement | null;
  /** Another panel is showing: the board and its bar are withdrawn (D-03). */
  readonly hidden?: boolean;
}

const STACK_TIP = ' · shift-click to add it to what is already on';
const FALLBACK_WIDTH = 1200;

/** Plain glyphs until the kit's icon set lands (SL03); the label names the head. */
const GLYPH: Readonly<Record<string, string>> = {
  building: '▦',
  calendar: '◷',
  comment: '◌',
  person: '◍',
  tag: '◈',
};

export function BoardMachine<Row>(props: BoardMachineProps<Row>): ReactElement {
  const context = useMemo<BoardContext<Row>>(
    () => ({
      facets: props.facets,
      columns: props.columns,
      presets: props.presets ?? [],
      modes: props.modes ?? [],
    }),
    [props.facets, props.columns, props.presets, props.modes],
  );
  const [machine, setMachine] = useState<MachineState>(() =>
    initialMachine({ ...readView(props.address ?? '', context), widths: props.widths ?? null }),
  );
  const dispatch = (action: BoardAction): void => {
    setMachine((current) => reduceBoard(current, action, context));
  };
  const view = machine.view;

  // The address follows the view; the first view is the address it came from.
  const written = useRef(writeView(machine.view));
  const { onAddress } = props;
  useEffect(() => {
    const next = writeView(view);
    if (next === written.current) return;
    written.current = next;
    onAddress?.(next);
  }, [view, onAddress]);

  // The widths to keep follow the view too; the first ones are the saved ones.
  const reported = useRef(machine.view.widths);
  const { onWidths } = props;
  useEffect(() => {
    if (view.widths === reported.current) return;
    reported.current = view.widths;
    onWidths?.(view.widths);
  }, [view.widths, onWidths]);

  // ⌘Z and ⌘⇧Z (Ctrl on other systems) step the view anywhere on the page,
  // except in a field that has its own undo: the search field and any other.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[data-board-search], input, textarea, select, [contenteditable]') !== null
      ) {
        return;
      }
      event.preventDefault();
      setMachine((current) =>
        reduceBoard(current, { type: event.shiftKey ? 'redo' : 'undo' }, context),
      );
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [context]);

  const card = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(FALLBACK_WIDTH);
  useEffect(() => {
    const element = card.current;
    if (props.width !== undefined || element === null || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setMeasured(entry.contentRect.width);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [props.width]);
  const available = props.width ?? measured;
  const viewport =
    props.viewport ?? (typeof window === 'undefined' ? available : window.innerWidth);
  // A drag in progress draws its widths live and is one history step when
  // the pointer lets go; a cancelled one leaves nothing behind.
  const [live, setLive] = useState<{
    readonly key: string;
    readonly widths: ColumnWidths | null;
  } | null>(null);
  const layout = layoutColumns(props.columns, { viewport, available }, live?.widths ?? view.widths);
  const endDrag = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      endDrag.current?.();
    },
    [],
  );
  const startDrag = (key: string, startX: number): void => {
    endDrag.current?.();
    const from = layout;
    const previous = view.widths;
    let latest: ColumnWidths | null = null;
    const move = (event: MouseEvent): void => {
      latest = widthsAfterDrag(props.columns, from, previous, key, event.clientX - startX);
      setLive({ key, widths: latest });
    };
    const stop = (keep: boolean): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      endDrag.current = null;
      setLive(null);
      if (keep && latest !== null) dispatch({ type: 'resize', key, widths: latest });
    };
    const up = (): void => {
      stop(true);
    };
    const cancel = (): void => {
      stop(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    endDrag.current = cancel;
    setLive({ key, widths: null });
  };
  const nudge = (key: string, dx: number): void => {
    const widths = widthsAfterDrag(props.columns, layout, view.widths, key, dx);
    if (widths !== null) dispatch({ type: 'resize', key, widths });
  };

  // The funnel menu (MP-5-7): open, its "Find a filter…" text, and Show all.
  // All three are the menu's own and never the view's: they narrow controls.
  const [menu, setMenu] = useState({ open: false, q: '', all: false });
  const funnel = useRef<HTMLButtonElement>(null);
  const funnelWrap = useRef<HTMLDivElement>(null);
  const find = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!menu.open) return undefined;
    find.current?.focus();
    const onDown = (event: Event): void => {
      const target = event.target;
      if (target instanceof Node && funnelWrap.current?.contains(target) === true) return;
      setMenu((current) => ({ ...current, open: false }));
    };
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('pointerdown', onDown);
    };
  }, [menu.open]);

  // The chip row fits by its ladder after every draw, and its height is
  // published for the heads' sticky offset. Both write the row's own element
  // and never its width, so nothing here can move what it measured.
  const chipRow = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = chipRow.current;
    const root = card.current;
    if (row === null || root === null) return;
    const apply = (tier: ChipTier): void => {
      row.setAttribute('data-tier', String(tier));
      if (typeof tier === 'number') row.style.setProperty('--catw', `${String(tier)}px`);
      else row.style.removeProperty('--catw');
    };
    const chips = row.querySelectorAll('.cbd__preset');
    const first = row.firstElementChild;
    const last = chips.item(chips.length - 1);
    if (first === null || chips.length === 0) apply('words');
    else {
      apply(
        fitChipRow((tier) => {
          apply(tier);
          return last.getBoundingClientRect().top < first.getBoundingClientRect().bottom;
        }),
      );
    }
    const height = `${String(Math.round(row.getBoundingClientRect().height))}px`;
    if (root.style.getPropertyValue('--catbar-h') !== height) {
      root.style.setProperty('--catbar-h', height);
    }
  });

  const narrowed = narrowRows(props.rows, view, props.facets, props.hay);
  const sorted = sortRows(narrowed, view.sort, props.columns);
  const presets = props.presets ?? [];
  const onPresets = presets.filter(
    (preset) => preset.facetIds.length > 0 && preset.facetIds.every((id) => view.ids.includes(id)),
  );
  const shownByPreset = new Set(onPresets.flatMap((preset) => preset.facetIds));
  const line = readingLine(view, props.facets, narrowed.length, props.withheld);
  const mode = (props.modes ?? []).find((one) => one.id === view.mode);
  const last = machine.history.past.at(-1);
  const next = machine.history.future.at(-1);
  const rest = view.ids.length === 0 && view.text.length === 0;
  const hidden = hiddenFilters(view, presets);
  const funnelLabel =
    hidden === 0 ? 'Filters' : `Filters, ${String(hidden)} on that this bar does not show`;
  const listing = funnelMenu(rankFacets(props.rows, props.facets), menu.q, menu.all);
  const stamp = freshness(props.changedAt ?? null, props.now ?? new Date());

  const command = (
    <div className="cbd__cmd">
      <BoardSearch
        facets={props.facets}
        names={props.rows.map(props.name)}
        noun={props.noun}
        have={view}
        onCommit={(raw) => {
          dispatch({ type: 'commit', raw });
        }}
        onTake={(item) => {
          if (item.facetId !== undefined) dispatch({ type: 'take', facetId: item.facetId });
          else if (item.text !== undefined) dispatch({ type: 'phrase', text: item.text });
        }}
        onDropLast={() => {
          dispatch({ type: 'dropLast' });
        }}
      />
      <div
        className="cbd__funnelw"
        ref={funnelWrap}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !menu.open) return;
          event.stopPropagation();
          setMenu((current) => ({ ...current, open: false }));
          funnel.current?.focus();
        }}
      >
        <button
          className={`cbd__ico cbd__funnel${menu.open ? ' is-on' : ''}`}
          data-funnel=""
          type="button"
          ref={funnel}
          aria-expanded={menu.open}
          aria-controls="cbd-menu"
          aria-label={funnelLabel}
          title={funnelLabel}
          onClick={() => {
            setMenu((current) => ({ ...current, open: !current.open }));
          }}
        >
          ⏷
          {hidden === 0 ? null : (
            <span className="cbd__badge" data-badge="" aria-hidden="true">
              {hidden}
            </span>
          )}
        </button>
        <div
          className="cbd__menu"
          id="cbd-menu"
          role="group"
          aria-label="Filters"
          hidden={!menu.open}
        >
          <div className="cbd__menuhd">
            <span className="cbd__flabel">Filters</span>
          </div>
          <label className="cbd__menuq">
            <input
              id="cbd-menu-q"
              ref={find}
              type="text"
              placeholder="Find a filter…"
              autoComplete="off"
              aria-label="Find a filter by name"
              value={menu.q}
              onChange={(event) => {
                const q = event.target.value;
                setMenu((current) => ({ ...current, q }));
              }}
            />
          </label>
          {listing.groups.map((group) => (
            <div className="cbd__menugrp" key={group.kind}>
              <span className="cbd__menuk">{group.kind}</span>
              {group.facets.map((one) => (
                <button
                  className="cbd__facet"
                  key={one.id}
                  type="button"
                  data-add={one.id}
                  data-count={one.count}
                  aria-pressed={view.ids.includes(one.id)}
                  title={`${String(one.count)} ${props.noun}s${STACK_TIP}`}
                  onClick={(event) => {
                    dispatch({ type: 'press', id: one.id, stack: event.shiftKey });
                  }}
                >
                  {one.label}
                </button>
              ))}
            </div>
          ))}
          {listing.shown === 0 && menu.q.trim() !== '' ? (
            <p className="cbd__menuempty">No filter matches “{menu.q.trim()}”.</p>
          ) : null}
          {listing.more > 0 || (menu.all && listing.shown > FUNNEL_FIRST) ? (
            <button
              className="cbd__lnk"
              type="button"
              data-showall=""
              aria-expanded={menu.all}
              onClick={() => {
                setMenu((current) => ({ ...current, all: !current.all }));
              }}
            >
              {menu.all ? 'Show fewer filters' : `Show all filters (${String(listing.more)} more)`}
            </button>
          ) : null}
        </div>
      </div>
      {view.widths === null ? null : (
        <button
          className="cbd__ico"
          data-reset=""
          type="button"
          title="Reset columns"
          aria-label="Reset columns"
          onClick={() => {
            dispatch({ type: 'resetWidths' });
          }}
        >
          ↔
        </button>
      )}
      <button
        className="cbd__ico"
        data-undo=""
        type="button"
        disabled={last === undefined}
        title={last === undefined ? 'Nothing to undo' : `Undo ${last.label}`}
        aria-label={last === undefined ? 'Nothing to undo' : `Undo ${last.label}`}
        onClick={() => {
          dispatch({ type: 'undo' });
        }}
      >
        ↶
      </button>
      <button
        className="cbd__ico"
        data-redo=""
        type="button"
        disabled={next === undefined}
        title={next === undefined ? 'Nothing to redo' : `Redo ${next.label}`}
        aria-label={next === undefined ? 'Nothing to redo' : `Redo ${next.label}`}
        onClick={() => {
          dispatch({ type: 'redo' });
        }}
      >
        ↷
      </button>
      <button
        className="btn btn--primary btn--sm cbd__clear"
        type="button"
        disabled={rest}
        title={rest ? 'Nothing to clear' : 'Drop every filter and search term'}
        onClick={() => {
          dispatch({ type: 'clear' });
        }}
      >
        Clear all
      </button>
      {stamp === null ? null : (
        <span className="cbd__fresh" data-freshness="" title={props.changedAt ?? undefined}>
          <span className="cbd__freshl">{stamp.long}</span>
          <span className="cbd__freshs" aria-hidden="true">
            {stamp.short}
          </span>
        </span>
      )}
    </div>
  );
  const bar = props.hidden === true ? null : props.bar ? createPortal(command, props.bar) : command;

  return (
    <div className="cbd" data-board="" ref={card} hidden={props.hidden === true}>
      {bar}

      <div className="cbd__filters" ref={chipRow}>
        {presets.map((preset) => (
          <PresetChip
            key={preset.id}
            preset={preset}
            on={onPresets.includes(preset)}
            count={presetCount(props.rows, preset, props.facets, props.hay)}
            onPress={(stack) => {
              dispatch({ type: 'preset', id: preset.id, stack });
            }}
          />
        ))}
        {(props.modes ?? []).map((one) => (
          <button
            key={one.id}
            className={`cbd__mode${view.mode === one.id ? ' is-on' : ''}`}
            data-mode={one.id}
            type="button"
            aria-pressed={view.mode === one.id}
            onClick={() => {
              dispatch({ type: 'mode', id: one.id });
            }}
          >
            {one.label}
          </button>
        ))}
        {view.ids
          .filter((id) => !shownByPreset.has(id))
          .map((id) => props.facets.find((facet) => facet.id === id))
          .map((facet) =>
            facet === undefined ? null : (
              <Tag
                key={facet.id}
                kind={facet.kind}
                label={facet.label}
                onDrop={() => {
                  dispatch({ type: 'drop', id: facet.id });
                }}
              />
            ),
          )}
        {view.text.map((term) => (
          <Tag
            key={`text:${term}`}
            kind="Text"
            label={term}
            onDrop={() => {
              dispatch({ type: 'dropText', text: term });
            }}
          />
        ))}
      </div>

      {line === '' ? null : <p className="cbd__read">{line}</p>}

      {mode !== undefined ? (
        mode.render(narrowed)
      ) : sorted.length === 0 ? (
        <div className="cbd__empty">
          <Empty title={props.empty.title} description={props.empty.description} />
        </div>
      ) : (
        <Table
          layout={layout.columns}
          tableWidth={layout.tableWidth}
          columns={props.columns}
          rows={sorted}
          sort={view.sort}
          groups={props.groups}
          rowKey={props.rowKey}
          cell={props.cell}
          onSort={(key) => {
            dispatch({ type: 'sort', key });
          }}
          grip={{ live: live?.key ?? null, start: startDrag, nudge }}
        />
      )}
    </div>
  );
}

function PresetChip(props: {
  readonly preset: Preset;
  readonly on: boolean;
  readonly count: number;
  readonly onPress: (stack: boolean) => void;
}): ReactElement {
  return (
    <button
      className={`cbd__preset${props.on ? ' is-on' : ''}`}
      data-preset={props.preset.id}
      type="button"
      aria-pressed={props.on}
      aria-label={props.preset.label}
      title={`${props.preset.label}${STACK_TIP}`}
      onClick={(event) => {
        props.onPress(event.shiftKey);
      }}
    >
      <span className="cbd__presi" data-icon={props.preset.icon} aria-hidden="true">
        {GLYPH[props.preset.icon ?? ''] ?? props.preset.label.charAt(0)}
      </span>
      <span className="cbd__presetw">{props.preset.label}</span>
      <span className="cbd__count">{props.count}</span>
    </button>
  );
}

function Tag(props: {
  readonly kind: string;
  readonly label: string;
  readonly onDrop: () => void;
}): ReactElement {
  return (
    <span className="cbd__tag">
      <span className="cbd__tagk">{props.kind}</span>
      {props.label}
      <button
        className="cbd__tagx"
        type="button"
        aria-label={`Remove ${props.label}`}
        onClick={props.onDrop}
      >
        ×
      </button>
    </span>
  );
}

function Table<Row>(props: {
  readonly layout: readonly LaidColumn[];
  readonly tableWidth: number | null;
  readonly columns: readonly ColumnSpec<Row>[];
  readonly rows: readonly Row[];
  readonly sort: { readonly key: string; readonly dir: 'asc' | 'desc' } | null;
  readonly groups: BoardMachineProps<Row>['groups'];
  readonly rowKey: (row: Row) => string;
  readonly cell: (row: Row, key: string) => ReactNode;
  readonly onSort: (key: string) => void;
  readonly grip: {
    readonly live: string | null;
    readonly start: (key: string, clientX: number) => void;
    readonly nudge: (key: string, dx: number) => void;
  };
}): ReactElement {
  const specOf = (key: string): ColumnSpec<Row> | undefined =>
    props.columns.find((column) => column.key === key);
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
  const body: ReactElement[] = [];
  if (grouped === undefined) {
    for (const row of props.rows) body.push(drawRow(row));
  } else {
    const seen = [...new Set(props.rows.map(grouped.of))];
    const order = [...grouped.order, ...seen.filter((group) => !grouped.order.includes(group))];
    for (const group of order) {
      const rows = props.rows.filter((row) => grouped.of(row) === group);
      if (rows.length === 0) continue;
      body.push(
        <tr className="cbd__grp" key={`group:${group}`}>
          <td colSpan={props.layout.length}>
            <span className="cbd__grpb">{group}</span>
          </td>
        </tr>,
      );
      for (const row of rows) body.push(drawRow(row));
    }
  }
  return (
    <div className="cbd__wrap">
      <table
        className="cbd__tbl"
        style={
          props.tableWidth === null
            ? undefined
            : { width: `${String(props.tableWidth)}px`, minWidth: `${String(props.tableWidth)}px` }
        }
      >
        <colgroup>
          {props.layout.map((column) => (
            <col key={column.key} style={{ width: `${column.pct.toFixed(4)}%` }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {props.layout.map((column, index) => {
              const spec = specOf(column.key);
              const label = spec?.label ?? column.key;
              const sorted = props.sort?.key === column.key ? props.sort.dir : undefined;
              return (
                <th
                  key={column.key}
                  data-key={column.key}
                  data-align={column.align}
                  data-tight={column.tight ? '' : undefined}
                  aria-sort={
                    sorted === undefined ? 'none' : sorted === 'asc' ? 'ascending' : 'descending'
                  }
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
                  {index === props.layout.length - 1 ? null : (
                    <span
                      className={`cbd__grip${props.grip.live === column.key ? ' is-live' : ''}`}
                      data-grip={column.key}
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${label}`}
                      aria-valuenow={Math.round(column.px)}
                      aria-valuemin={spec?.min ?? 0}
                      tabIndex={0}
                      title="Drag, or use the arrow keys, to resize"
                      onPointerDown={(event) => {
                        event.preventDefault();
                        props.grip.start(column.key, event.clientX);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
                        event.preventDefault();
                        const step = event.shiftKey ? GRIP_STEP_LARGE : GRIP_STEP;
                        props.grip.nudge(column.key, event.key === 'ArrowRight' ? step : -step);
                      }}
                    />
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>{body}</tbody>
      </table>
    </div>
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
