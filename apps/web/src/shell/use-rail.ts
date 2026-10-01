// SPDX-License-Identifier: AGPL-3.0-only
//
// The nav rail as the person left it (MP-2-3): folded to the icon strip or
// open, and its width while open, held to 170 to 400. A drag moves it live
// and a release keeps it; a fold keeps it at once.
//
// What is kept is the `rail.collapsed` and `rail.width` keys of MP-2-11's one
// preference store (layout-store.ts), handed in before the first render so the
// shell draws it before paint. Only the width under a moving grip is held here.

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
  stored: RailPreference,
  save: (key: 'rail.collapsed' | 'rail.width', value: boolean | number) => void,
): RailModel {
  const [moving, setMoving] = useState<number | null>(null);
  const width = moving ?? stored.width;
  return {
    collapsed: stored.collapsed,
    width,
    drawn: stored.collapsed ? RAIL_STRIP : width,
    fold: () => {
      save('rail.collapsed', !stored.collapsed);
    },
    resize: (next) => {
      setMoving(clampRail(next));
    },
    keep: (next) => {
      setMoving(null);
      save('rail.width', clampRail(next));
    },
  };
}
