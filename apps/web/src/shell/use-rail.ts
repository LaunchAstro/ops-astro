// SPDX-License-Identifier: AGPL-3.0-only
//
// The nav rail as the person left it (MP-2-3): folded to the icon strip or
// open, and its width while open, held to 170 to 400. A drag moves it live
// and a release keeps it; a fold keeps it at once.
//
// It is handed in before the first render, so the shell draws it before
// paint, and a keep tells the saver. Both become the `rail.collapsed` and
// `rail.width` keys of MP-2-11's one preference store when that is on main;
// until then the rail lives in memory for the tab's life.

import { useState } from 'react';
import { RAIL_DEFAULT, RAIL_MAX, RAIL_MIN, RAIL_STRIP } from '@launchastro/ui';

/** Folded to the icon strip or not, and its width when open. */
export interface RailPreference {
  readonly collapsed: boolean;
  readonly width: number;
}

export interface RailModel extends RailPreference {
  /** The width it is drawn at: the strip's while folded. */
  readonly drawn: number;
  readonly fold: () => void;
  /** Its width while the grip moves. */
  readonly resize: (width: number) => void;
  /** The width the grip was let go at. */
  readonly keep: (width: number) => void;
}

export const clampRail = (width: number): number =>
  Math.max(RAIL_MIN, Math.min(Math.round(width), RAIL_MAX));

/** A stored rail as it may arrive: a field that is not a boolean or a finite number is refused for the default. */
export function railFrom(stored: unknown): RailPreference {
  const value = (typeof stored === 'object' && stored !== null ? stored : {}) as Record<
    string,
    unknown
  >;
  const width = value['width'];
  return {
    collapsed: value['collapsed'] === true,
    width: typeof width === 'number' && Number.isFinite(width) ? clampRail(width) : RAIL_DEFAULT,
  };
}

export function useRail(
  stored: RailPreference | undefined,
  save: ((preference: RailPreference) => void) | undefined,
): RailModel {
  const [rail, setRail] = useState(() => railFrom(stored));
  // Told outside the state updater, so a strict render's second run saves nothing twice.
  const kept = (next: RailPreference): void => {
    setRail(next);
    save?.(next);
  };
  return {
    ...rail,
    drawn: rail.collapsed ? RAIL_STRIP : rail.width,
    fold: () => {
      kept({ ...rail, collapsed: !rail.collapsed });
    },
    resize: (width) => {
      setRail({ ...rail, width: clampRail(width) });
    },
    keep: (width) => {
      kept({ ...rail, width: clampRail(width) });
    },
  };
}
