// SPDX-License-Identifier: AGPL-3.0-only
//
// The person's column widths (MP-5-6) between the board and the store that
// keeps them. A drag, an arrow step, a reset or an undo is told out through
// `onWidths`. A stored value that is not the board's own last change, a read
// that answers late or the stored widths back after a refused save, is drawn
// at once, outside the undo history. The store handing back what the board
// just told it is neither drawn again nor told again, so a change made while
// an earlier one is still coming back is never undone by it.

import { useEffect, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { sameWidths } from '../board/widths.ts';
import type { ColumnWidths, MachineState } from '../board/types.ts';

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
    if (sameWidths(agreed.current, stored) || !sameWidths(agreed.current, drawn)) return;
    agreed.current = stored;
    setMachine((current) => ({ ...current, view: { ...current.view, widths: stored } }));
  }, [stored, drawn, setMachine]);
  useEffect(() => {
    if (sameWidths(agreed.current, drawn)) return;
    agreed.current = drawn;
    tell.current?.(drawn);
  }, [drawn]);
}
