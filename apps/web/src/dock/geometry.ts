// SPDX-License-Identifier: AGPL-3.0-only
//
// THE DOCK'S GEOMETRY (MP-3-2), as one function of the window, the nav rail,
// the one stored panel width and the open panels in rank order.
//
// Every open panel is the same width: the stored width, held at the 380 floor
// and at the ceiling where the group would pass the nav rail. The group seats
// as a grid track, narrowing the content, only from 1440 wide and only while
// the content keeps its 836 floor; otherwise it floats over the page and the
// content keeps its width. So a drag walks from seated to floating as the
// width crosses the seat line, with no threshold of its own.
//
// Where the panels cannot all fit at the floor, the lowest-ranked open panel
// closes and the caller says so in one line (R39). The mockup drew them below
// the floor and unequal instead (its D-5).
//
// Below 1280 the dock is a sheet under the content, MP-3-3's geometry.

import type { PanelId } from '../panels.ts';

/** The rail's width, which the seat test keeps clear beside the content. */
export const RAIL_WIDTH = 40;
export const PANEL_DEFAULT = 550;
export const PANEL_FLOOR = 380;
export const CONTENT_FLOOR = 836;
/** The narrowest window that can seat a panel: a nav rail, the content floor and a floor panel. */
export const SEAT_FROM = 1440;
/** Below this the side tier gives way to the sheet. */
export const SIDE_FROM = 1280;

export interface DockGeometry {
  readonly mode: 'rest' | 'seated' | 'floating' | 'sheet';
  /** The panels that draw, in rank order: the open ones, less any R39 closed. */
  readonly open: readonly PanelId[];
  /** The panel R39 closed to make room, or null. */
  readonly closes: PanelId | null;
  readonly panelWidth: number;
  readonly groupWidth: number;
  /** Where the floating group starts, measured from the window's left edge. */
  readonly groupLeft: number;
  /** The content column's width. */
  readonly content: number;
}

export function dockGeometry(input: {
  readonly viewport: number;
  readonly navRail: number;
  /** The one stored width every panel shares. */
  readonly width: number;
  /** The open panels, in rank order. */
  readonly open: readonly PanelId[];
}): DockGeometry {
  const { viewport, navRail } = input;
  const beside = viewport - navRail;
  let open = input.open;
  let closes: PanelId | null = null;
  const at = (mode: DockGeometry['mode'], panelWidth = 0, content = beside): DockGeometry => ({
    mode,
    open,
    closes,
    panelWidth,
    groupWidth: panelWidth * open.length,
    groupLeft: viewport - panelWidth * open.length,
    content,
  });
  if (viewport < SIDE_FROM) return at('sheet');
  // One close at most: the side tier holds two panels at the floor at 1280.
  if (open.length > 1 && Math.floor(beside / open.length) < PANEL_FLOOR) {
    closes = open.at(-1) ?? null;
    open = open.slice(0, -1);
  }
  if (open.length === 0) return at('rest');
  const ceiling = Math.floor(beside / open.length);
  const panelWidth = Math.max(PANEL_FLOOR, Math.min(input.width, ceiling));
  const group = panelWidth * open.length;
  const seats = viewport >= SEAT_FROM && group <= beside - RAIL_WIDTH - CONTENT_FLOOR;
  return seats ? at('seated', panelWidth, beside - group) : at('floating', panelWidth);
}
