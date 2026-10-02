// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock's layout as the application holds it (MP-3-2): the window's width,
// the one panel width every panel shares, and the geometry they give. Where
// the window cannot hold every open panel at the floor, the lowest-ranked one
// closes through the open set, as a close from anywhere does, and one line
// says so (R39).
//
// The width and the sheet height are the `dock.width` and `dock.sheetHeight`
// keys of MP-2-11's one preference store (shell/layout-store.ts), no dock record
// of their own: handed in before the first render and saved once on release.
// Only the value under a moving grip is held here.

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
import type { Layout, LayoutStore } from '../shell/layout-store.ts';

const COUNT = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

export interface DockLayoutModel {
  readonly geometry: DockGeometry;
  readonly width: number;
  readonly setWidth: (width: number) => void;
  /** The width the grip was let go at, to keep. */
  readonly keepWidth: (width: number) => void;
  readonly stamp: string | null;
  /** The one sheet height below the side tier, and the most the window allows. */
  readonly sheetHeight: number;
  readonly sheetMax: number;
  readonly setSheetHeight: (height: number) => void;
  readonly keepSheetHeight: (height: number) => void;
}

/** A stored length as the grip takes it: a finite number, or the default. */
const lengthOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;

/** The window's width and height, followed as it is resized. */
function useWindowSize(): { readonly viewport: number; readonly tall: number } {
  const [size, setSize] = useState(() => ({
    viewport: window.innerWidth,
    tall: window.innerHeight,
  }));
  useEffect(() => {
    const onResize = (): void => {
      setSize({ viewport: window.innerWidth, tall: window.innerHeight });
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);
  return size;
}

/** `navRail` is the nav rail as drawn: the person's width, or the strip's while folded (MP-2-3). */
export function useDockLayout(
  dock: DockModel,
  registry: PanelRegistry,
  navRail: number,
  store: { readonly layout: Layout; readonly save: LayoutStore['save'] },
): DockLayoutModel {
  const { viewport, tall } = useWindowSize();
  const [moving, setMoving] = useState<{ width?: number; sheet?: number }>({});
  const width = moving.width ?? lengthOr(store.layout['dock.width'], PANEL_DEFAULT);
  const sheet = moving.sheet ?? lengthOr(store.layout['dock.sheetHeight'], SHEET_DEFAULT);
  const [stamp, setStamp] = useState<string | null>(null);

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
    setWidth: (next) => {
      setMoving({ width: next });
    },
    keepWidth: (next) => {
      setMoving({});
      store.save('dock.width', Math.round(next));
    },
    stamp,
    sheetHeight: clampSheet(sheet, tall),
    sheetMax: tall - SHEET_GAP,
    setSheetHeight: (height) => {
      setMoving({ sheet: clampSheet(height, tall) });
    },
    keepSheetHeight: (height) => {
      setMoving({});
      store.save('dock.sheetHeight', clampSheet(height, tall));
    },
  };
}
