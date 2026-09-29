// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock's layout as the application holds it (MP-3-2): the window's width,
// the one panel width every panel shares, and the geometry they give. Where
// the window cannot hold every open panel at the floor, the lowest-ranked one
// closes through the open set, as a close from anywhere does, and one line
// says so (R39).
//
// The width lives in memory here. It becomes the `dock.width` key of the one
// preference store when MP-2-11 is on main; no dock record of its own.

import { useEffect, useState } from 'react';
import type { PanelRegistry } from '../panels.ts';
import { PANEL_DEFAULT, dockGeometry, type DockGeometry } from './geometry.ts';
import { close, ranked } from './open-set.ts';
import type { DockModel } from './use-dock.ts';

/** The nav rail's width at rest. MP-2-3 makes it the person's own. */
export const NAV_RAIL = 224;

const COUNT = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

export interface DockLayoutModel {
  readonly geometry: DockGeometry;
  readonly width: number;
  readonly setWidth: (width: number) => void;
  readonly stamp: string | null;
}

export function useDockLayout(dock: DockModel, registry: PanelRegistry): DockLayoutModel {
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const [width, setWidth] = useState(PANEL_DEFAULT);
  const [stamp, setStamp] = useState<string | null>(null);
  useEffect(() => {
    const onResize = (): void => {
      setViewport(window.innerWidth);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const open = ranked(dock.state);
  const geometry = dockGeometry({ viewport, navRail: NAV_RAIL, width, open });
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

  return { geometry, width, setWidth, stamp };
}
