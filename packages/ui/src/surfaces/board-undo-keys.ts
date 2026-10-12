// SPDX-License-Identifier: AGPL-3.0-only
//
// The board's undo keys (U09), for `useBoardMachine` in board-hooks.ts.

import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { reduceBoard } from '../board/machine.ts';
import type { BoardContext, MachineState } from '../board/types.ts';

/**
 * ⌘Z and ⌘⇧Z (Ctrl on other systems) step the view anywhere on the page,
 * except in a field that has its own undo: the search field and any other.
 * A hidden board listens for neither. With two boards in view (a page and a
 * dock panel), a key pressed in one (`owns`) steps that one alone, first; a
 * key pressed outside every board steps the first board to hear it, once.
 */
export function useUndoKeys<Row>(
  setMachine: Dispatch<SetStateAction<MachineState>>,
  context: (on: readonly string[]) => BoardContext<Row>,
  hidden: boolean,
  owns: (node: Node) => boolean,
): void {
  const ownsRef = useRef(owns);
  ownsRef.current = owns;
  useEffect(() => {
    if (hidden) return;
    const step = (event: KeyboardEvent, mine: boolean): void => {
      if (event.defaultPrevented) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (mine !== ownsRef.current(target)) return;
      if (!mine && target instanceof Element && target.closest('[data-board]') !== null) return;
      if (
        target instanceof Element &&
        target.closest('[data-board-search], input, textarea, select, [contenteditable]') !== null
      ) {
        return;
      }
      event.preventDefault();
      const type = event.shiftKey ? 'redo' : 'undo';
      setMachine((current) => reduceBoard(current, { type }, context(current.view.ids)));
    };
    // The board pressed in takes the key on the way down, before any other hears it.
    const own = (event: KeyboardEvent): void => {
      step(event, true);
    };
    const anyone = (event: KeyboardEvent): void => {
      step(event, false);
    };
    document.addEventListener('keydown', own, true);
    document.addEventListener('keydown', anyone);
    return () => {
      document.removeEventListener('keydown', own, true);
      document.removeEventListener('keydown', anyone);
    };
  }, [setMachine, context, hidden]);
}
