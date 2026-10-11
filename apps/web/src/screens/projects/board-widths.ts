// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects board's column widths (MP-5-6, CS-5.6, CS-5.8) as the one
// preference store keeps them: this board's entries of `columns.widths`, each
// named `projects.<column>`, beside any other board's. A drag, an arrow step,
// Reset columns or an undo saves the key with this board's entries replaced
// (`usePreferences`, not audited). A refused save is said, and the stored
// widths come back with the reread; a failed read leaves the defaults.

import { useMemo } from 'react';
import { WIDTHS_PREFERENCE, isWidth, widthsToPreference, type ColumnWidths } from '@launchastro/ui';
import type { OperationsClient } from '../../operations/client.ts';
import { usePreferences } from '../../data/use-preferences.ts';
import { isRecord } from '../../session/token.ts';

const BOARD = 'projects';

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
   * that fails is not said: the board keeps its default widths.
   */
  readonly because: string | null;
}

export function useBoardWidths(client: OperationsClient, grantKey: string): BoardWidths {
  const { preferences, because, save } = usePreferences(client, grantKey);
  const stored = preferences?.[WIDTHS_PREFERENCE];
  const widths = useMemo(() => boardWidths(stored), [stored]);
  return {
    widths,
    because: preferences === null ? null : because,
    onWidths: (next) => {
      save(WIDTHS_PREFERENCE, widthsToPreference(BOARD, stored, next));
    },
  };
}
