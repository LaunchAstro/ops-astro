// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects board's column widths (MP-5-6, CS-5.6, CS-5.8) as the one
// preference store keeps them: this board's entries of `columns.widths`, each
// named `projects.<column>`, beside any other board's. A drag, an arrow step,
// Reset columns or an undo saves the key with this board's entries replaced
// (`usePreferences`, not audited). A change made before the first read
// answers is drawn and held, then saved onto what the read brings, so no other
// board's entries are lost. A refused save is said, and the stored widths come
// back with the reread. A failed read leaves the defaults and saves nothing
// until a change is made: that change reads again and is saved onto what the
// reread brings, or, when it fails too, the board says widths are not kept.

import { useEffect, useMemo, useState } from 'react';
import { WIDTHS_PREFERENCE, isWidth, widthsToPreference, type ColumnWidths } from '@launchastro/ui';
import type { OperationsClient } from '../../operations/client.ts';
import { usePreferences } from '../../data/use-preferences.ts';
import { isRecord } from '../../session/token.ts';

const BOARD = 'projects';
const NOT_KEPT = 'Column widths are not being kept: your preferences could not be read.';

/** This board's widths in the stored key, or null for the defaults. */
function boardWidths(stored: unknown): ColumnWidths | null {
  const prefix = `${BOARD}.`;
  const own = Object.entries(isRecord(stored) ? stored : {}).flatMap(([name, width]) =>
    name.startsWith(prefix) && isWidth(width) ? [[name.slice(prefix.length), width] as const] : [],
  );
  return own.length === 0 ? null : Object.fromEntries(own);
}

export interface BoardWidths {
  readonly widths: ColumnWidths | null;
  readonly onWidths: (widths: ColumnWidths | null) => void;
  /**
   * Why the last save failed, in plain words; null when none did. A first read
   * that fails is not said until a change cannot be kept.
   */
  readonly because: string | null;
}

export function useBoardWidths(client: OperationsClient, grantKey: string): BoardWidths {
  const { preferences, because, save, unread, reread } = usePreferences(client, grantKey);
  // A change made before the read answers, held for its owner. Nothing is
  // saved until then, so `preferences` is null until the read answers.
  const [early, setEarly] = useState<{
    readonly of: string;
    readonly next: ColumnWidths | null;
  } | null>(null);
  const held = early?.of === grantKey ? early : null;
  const read = preferences?.[WIDTHS_PREFERENCE];
  const stored = useMemo(
    () => (held === null ? read : widthsToPreference(BOARD, read, held.next)),
    [held, read],
  );
  const widths = useMemo(() => boardWidths(stored), [stored]);
  const answered = preferences !== null;
  useEffect(() => {
    if (held === null || !answered) return;
    setEarly(null);
    save(WIDTHS_PREFERENCE, stored);
  }, [held, answered]);
  return {
    widths,
    because: answered ? because : held !== null && unread ? NOT_KEPT : null,
    onWidths: (next) => {
      if (!answered) {
        setEarly({ of: grantKey, next });
        // After a failed read, the change reads again, to be saved onto its answer.
        if (unread) reread();
        return;
      }
      setEarly(null);
      save(WIDTHS_PREFERENCE, widthsToPreference(BOARD, stored, next));
    },
  };
}
