// SPDX-License-Identifier: AGPL-3.0-only
//
// The person's column widths (MP-5-6) between the board and the store that
// keeps them. A drag, an arrow step, a reset or an undo is told out through
// `onWidths`. A stored value that is not the board's own last change, a read
// that answers late or the stored widths back after a refused save, is drawn
// at once, outside the undo history; each held step that still had the
// widths it replaces takes it too, so undoing a sort or filter made before it
// never brings the replaced widths back. The store handing back what the board
// just told it is neither drawn again nor told again, so a change made while
// an earlier one is still coming back is never undone by it.

import { useEffect, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { sameWidths } from '../board/widths.ts';
import type { BoardView, ColumnWidths, MachineState } from '../board/types.ts';

export function useStoredWidths(
  setMachine: Dispatch<SetStateAction<MachineState>>,
  drawn: ColumnWidths | null,
  stored: ColumnWidths | null,
  onWidths: ((widths: ColumnWidths | null) => void) | undefined,
): void {
  // The widths the board and the store last agreed on, and the latest teller.
  const agreed = useRef(stored);
  const tell = useRef(onWidths);
  tell.current = onWidths;
  useLayoutEffect(() => {
    // A change on the board not told yet is newer than any stored value.
    const replaced = agreed.current;
    if (sameWidths(replaced, stored) || !sameWidths(replaced, drawn)) return;
    agreed.current = stored;
    const take = (view: BoardView): BoardView =>
      sameWidths(view.widths, replaced) ? { ...view, widths: stored } : view;
    const held = (steps: MachineState['history']['past']) =>
      steps.map((step) => ({ ...step, view: take(step.view) }));
    setMachine((current) => ({
      view: { ...current.view, widths: stored },
      history: { past: held(current.history.past), future: held(current.history.future) },
    }));
  }, [stored, drawn, setMachine]);
  useEffect(() => {
    if (sameWidths(agreed.current, drawn)) return;
    agreed.current = drawn;
    tell.current?.(drawn);
  }, [drawn]);
}
