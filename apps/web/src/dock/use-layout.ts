// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock's layout as the application holds it (MP-3-2): the window's width,
// the one panel width every panel shares, and the geometry they give. Where
// the window cannot hold every open panel at the floor, the lowest-ranked one
// closes through the open set, as a close from anywhere does, and one line
// says so (R39).
//
// The width and the sheet height live in memory here. They become the
// `dock.width` and `dock.sheetHeight` keys of the one preference store when
// MP-2-11 is on main; no dock record of their own.

import { useEffect, useState } from 'react';
import type { PanelRegistry } from '../panels.ts';
import {
  PANEL_DEFAULT,
  SHEET_DEFAULT,
  SHEET_GAP,
  clampSheet,
  dockGeometry,
  type DockGeometry,
} from './geometry.ts';
import { close, ranked } from './open-set.ts';
import type { DockModel } from './use-dock.ts';

const COUNT = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

export interface DockLayoutModel {
  readonly geometry: DockGeometry;
  readonly width: number;
  readonly setWidth: (width: number) => void;
  readonly stamp: string | null;
  /** The one sheet height below the side tier, and the most the window allows. */
  readonly sheetHeight: number;
  readonly sheetMax: number;
  readonly setSheetHeight: (height: number) => void;
}

/** `navRail` is the nav rail as drawn: the person's width, or the strip's while folded (MP-2-3). */
export function useDockLayout(
  dock: DockModel,
  registry: PanelRegistry,
  navRail: number,
): DockLayoutModel {
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const [tall, setTall] = useState(() => window.innerHeight);
  const [sheet, setSheet] = useState(SHEET_DEFAULT);
  const [width, setWidth] = useState(PANEL_DEFAULT);
  const [stamp, setStamp] = useState<string | null>(null);
  useEffect(() => {
    const onResize = (): void => {
      setViewport(window.innerWidth);
      setTall(window.innerHeight);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const open = ranked(dock.state);
  const geometry = dockGeometry({ viewport, navRail, width, open });
  const closes = geometry.closes;
  const { change } = dock;
  useEffect(() => {
    if (closes === null) return;
    change((state) => close(state, closes));
    const label = registry[closes]?.label ?? 'A panel';
    setStamp(
      `${label} closed: ${COUNT[open.length] ?? String(open.length)} panels do not fit at this width.`,
    );
  }, [closes, change, registry, open.length]);

  return {
    geometry,
    width,
    setWidth,
    stamp,
    sheetHeight: clampSheet(sheet, tall),
    sheetMax: tall - SHEET_GAP,
    setSheetHeight: (height) => {
      setSheet(clampSheet(height, tall));
    },
  };
}
