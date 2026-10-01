// SPDX-License-Identifier: AGPL-3.0-only
//
// Where the dock task panel goes at a width (MP-4-8, T-D19, DS-SIDE-7).
//
// **The seat line.** Open panels seat beside the page only when every one of
// them, at the width asked for, fits beside the 836 px content floor:
// `n × per ≤ vw − rail − 40 − 836`, and never under 1440 (`--bp-seat`). One
// 550 px panel seats from 1650 with the expanded rail (224) and from 1482
// with it collapsed (56).
//
// **Otherwise it floats at the width asked for** (owner answer 8, DR-64):
// it never narrows towards 380 to make the line; the 380 floor holds for a
// seated and a floating panel alike.
//
// **Below the side rail it is a sheet.** From 901 to 1279 the panel is the
// sheet under the content, and at 900 and under (the phone tier's strip,
// R33) it is the bottom sheet; both take the full width. The canonical
// breakpoints are 640, 900 and 1279; the bottom sheet starts at 640 here so
// the 900 capture shows the sheet the task page's spec draws.

import type { FrameFacts } from './frame-seam.ts';

export type Placement = 'seated' | 'floating' | 'sheet' | 'bottom-sheet';

export interface Seat {
  readonly placement: Placement;
  /** The panel's width in pixels; a sheet's is the viewport's. */
  readonly width: number;
}

/** The rail's width, expanded and collapsed (`--rail-w`). */
export const RAIL = { expanded: 224, collapsed: 56 } as const;
/** The dock's own tab rail beside the panels. */
const DOCK_RAIL = 40;
/** The page's content never goes under this beside a seated panel (`--content-floor`). */
const CONTENT_FLOOR = 836;
/** No panel, seated or floating, is narrower (R39). */
export const PANEL_FLOOR = 380;
/** Under this the dock never seats (`--bp-seat`). */
const SEAT_FROM = 1440;
/** At and under this the panel is a sheet under the content. */
const SHEET_AT = 1279;
/** At and under this the sheet is the phone's bottom sheet. */
const BOTTOM_SHEET_AT = 640;

export function seatFor(facts: FrameFacts): Seat {
  const { viewport } = facts;
  if (viewport <= BOTTOM_SHEET_AT) return { placement: 'bottom-sheet', width: viewport };
  if (viewport <= SHEET_AT) return { placement: 'sheet', width: viewport };
  const per = Math.max(PANEL_FLOOR, facts.asked);
  const rail = facts.railExpanded ? RAIL.expanded : RAIL.collapsed;
  const room = viewport - rail - DOCK_RAIL - CONTENT_FLOOR;
  const fits = viewport >= SEAT_FROM && facts.panels * per <= room;
  return { placement: fits ? 'seated' : 'floating', width: per };
}
