// SPDX-License-Identifier: AGPL-3.0-only
//
// The board machine's state and effects (U09 and U13), one concern a hook: the
// machine and what follows its view out (the address and the widths to keep),
// the page-wide undo keys, the card's measured width, a column drag, the
// funnel menu's own state, and the chip row's fit. `BoardMachine` calls them
// in this order, which is the order their effects run in.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import { layoutColumns } from '../board/columns.ts';
import { widthsAfterDrag } from '../board/widths.ts';
import { fitChipRow, type ChipTier } from '../board/funnel.ts';
import { initialMachine, reduceBoard } from '../board/machine.ts';
import { readView, writeView } from '../board/address.ts';
import type {
  BoardAction,
  BoardContext,
  BoardView,
  ColumnSpec,
  ColumnWidths,
  Layout,
  MachineState,
} from '../board/types.ts';

const FALLBACK_WIDTH = 1200;

type Send = (action: BoardAction) => void;

interface Follow {
  /** Told the new query whenever the view changes. */
  readonly onAddress?: (address: string) => void;
  /** Told the widths to keep whenever they change. */
  readonly onWidths?: (widths: ColumnWidths | null) => void;
}

/** The machine and its dispatch; the address and the widths follow its view out. */
export function useBoardMachine<Row>(
  context: BoardContext<Row>,
  opening: { readonly address?: string; readonly widths?: ColumnWidths | null },
  follow: Follow,
): { readonly machine: MachineState; readonly dispatch: Send } {
  const [machine, setMachine] = useState<MachineState>(() =>
    initialMachine({ ...readView(opening.address ?? '', context), widths: opening.widths ?? null }),
  );
  const dispatch = (action: BoardAction): void => {
    setMachine((current) => reduceBoard(current, action, context));
  };
  useFollow(machine.view, follow);
  useUndoKeys(setMachine, context);
  return { machine, dispatch };
}

/** The address and the widths to keep follow the view; the first of each is where it came from. */
function useFollow(view: BoardView, follow: Follow): void {
  const written = useRef(writeView(view));
  const { onAddress, onWidths } = follow;
  useEffect(() => {
    const next = writeView(view);
    if (next === written.current) return;
    written.current = next;
    onAddress?.(next);
  }, [view, onAddress]);
  const reported = useRef(view.widths);
  useEffect(() => {
    if (view.widths === reported.current) return;
    reported.current = view.widths;
    onWidths?.(view.widths);
  }, [view.widths, onWidths]);
}

/**
 * ⌘Z and ⌘⇧Z (Ctrl on other systems) step the view anywhere on the page,
 * except in a field that has its own undo: the search field and any other.
 */
function useUndoKeys<Row>(
  setMachine: Dispatch<SetStateAction<MachineState>>,
  context: BoardContext<Row>,
): void {
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
  }, [setMachine, context]);
}

/** The card's width: the one handed in, else measured as it resizes. */
export function useMeasuredWidth(
  card: RefObject<HTMLDivElement | null>,
  width: number | undefined,
): number {
  const [measured, setMeasured] = useState(FALLBACK_WIDTH);
  useEffect(() => {
    const element = card.current;
    if (width !== undefined || element === null || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setMeasured(entry.contentRect.width);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [card, width]);
  return width ?? measured;
}

/** A drag in progress: its column and the widths drawn live, null before the first move. */
export interface LiveDrag {
  readonly key: string;
  readonly widths: ColumnWidths | null;
}

/**
 * The table's layout and its grips. A drag draws its widths live and is one
 * history step when the pointer lets go; a cancelled one leaves nothing
 * behind. An arrow step is one history step at once.
 */
export function useColumnDrag<Row>(
  columns: readonly ColumnSpec<Row>[],
  room: { readonly viewport: number; readonly available: number },
  widths: ColumnWidths | null,
  dispatch: Send,
) {
  const [live, setLive] = useState<LiveDrag | null>(null);
  const layout = layoutColumns(columns, room, live?.widths ?? widths);
  const endDrag = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      endDrag.current?.();
    },
    [],
  );
  const start = (key: string, startX: number): void => {
    endDrag.current?.();
    const drag = { key, startX, columns, from: layout, previous: widths };
    endDrag.current = followPointer(drag, { setLive, endDrag, dispatch });
  };
  const nudge = (key: string, dx: number): void => {
    const next = widthsAfterDrag(columns, layout, widths, key, dx);
    if (next !== null) dispatch({ type: 'resize', key, widths: next });
  };
  return { layout, live, start, nudge };
}

/** Follows one drag's pointer until it lets go or is cancelled; answers the cancel. */
function followPointer<Row>(
  drag: {
    readonly key: string;
    readonly startX: number;
    readonly columns: readonly ColumnSpec<Row>[];
    readonly from: Layout;
    readonly previous: ColumnWidths | null;
  },
  to: {
    readonly setLive: (live: LiveDrag | null) => void;
    readonly endDrag: RefObject<(() => void) | null>;
    readonly dispatch: Send;
  },
): () => void {
  const { key } = drag;
  let latest: ColumnWidths | null = null;
  const move = (event: MouseEvent): void => {
    latest = widthsAfterDrag(
      drag.columns,
      drag.from,
      drag.previous,
      key,
      event.clientX - drag.startX,
    );
    to.setLive({ key, widths: latest });
  };
  const stop = (keep: boolean): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    to.endDrag.current = null;
    to.setLive(null);
    if (keep && latest !== null) to.dispatch({ type: 'resize', key, widths: latest });
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
  to.setLive({ key, widths: null });
  return cancel;
}

/** The funnel menu's own state (MP-5-7): never the view's, since it narrows controls. */
export interface MenuState {
  readonly open: boolean;
  readonly q: string;
  readonly all: boolean;
}

/** The funnel menu: open, its "Find a filter…" text and Show all; a press outside closes it. */
export function useFunnelMenu() {
  const [menu, setMenu] = useState<MenuState>({ open: false, q: '', all: false });
  const funnel = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const find = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!menu.open) return;
    find.current?.focus();
    const onDown = (event: Event): void => {
      const target = event.target;
      if (target instanceof Node && wrap.current?.contains(target) === true) return;
      setMenu((current) => ({ ...current, open: false }));
    };
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('pointerdown', onDown);
    };
  }, [menu.open]);
  return { menu, setMenu, funnel, wrap, find };
}

/**
 * The chip row fits by its ladder after every draw, and its height is
 * published as `--catbar-h` for the heads' sticky offset. Both write the row's
 * own element and never its width, so nothing here can move what it measured.
 */
export function useChipRowFit(
  chipRow: RefObject<HTMLDivElement | null>,
  card: RefObject<HTMLDivElement | null>,
): void {
  useLayoutEffect(() => {
    const row = chipRow.current;
    const root = card.current;
    if (row === null || root === null) return;
    const apply = (tier: ChipTier): void => {
      row.dataset['tier'] = String(tier);
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
}
