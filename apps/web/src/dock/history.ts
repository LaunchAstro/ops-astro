// SPDX-License-Identifier: AGPL-3.0-only
//
// THE DOCK'S HISTORY (MP-3-5): where the whole dock was, walked by the back
// and forward on every panel head. It is separate from the stack of open
// panels, and it lives in memory only: a new page load starts with one entry
// and both ways disabled.
//
// An entry is the whole dock: which panels are open, where each one is, and
// how far each is scrolled. Only a change of the open set or of a place adds
// an entry; scroll is sealed into the entry in hand, never pushed. A new place
// after a step back drops what lay ahead. At most 25, oldest out first.
//
// Walking back never reads anything itself: the application puts the dock
// where the entry says, and each panel reads its view again under the session
// in hand, so a record the person can no longer read is refused, not reopened.

import type { PanelId } from '../panels.ts';
import { ranked, type DockState } from './open-set.ts';

export const HISTORY_CAP = 25;

export interface DockEntry extends DockState {
  readonly scroll: { readonly [Id in PanelId]?: number };
}

export interface DockHistory {
  readonly entries: readonly DockEntry[];
  /** The entry the dock is on. */
  readonly at: number;
}

export const start = (state: DockState): DockHistory => ({
  entries: [{ open: state.open, places: state.places, scroll: {} }],
  at: 0,
});

/** Whether two states put the same panels in the same places. Open order is not a place. */
function samePlace(one: DockState, other: DockState): boolean {
  const ids = ranked(one);
  const others = ranked(other);
  return (
    ids.length === others.length &&
    ids.every((id, index) => id === others[index] && one.places[id] === other.places[id])
  );
}

/** The dock moved: a new entry if its place changed, and nothing otherwise. */
export function record(history: DockHistory, state: DockState): DockHistory {
  const here = history.entries[history.at];
  if (here !== undefined && samePlace(here, state)) return history;
  const kept = [
    ...history.entries.slice(0, history.at + 1),
    { open: state.open, places: state.places, scroll: {} },
  ];
  const entries = kept.slice(-HISTORY_CAP);
  return { entries, at: entries.length - 1 };
}

/** A panel scrolled: sealed into the entry in hand, if that panel is open in it. */
export function seal(history: DockHistory, id: PanelId, top: number): DockHistory {
  const here = history.entries[history.at];
  if (here === undefined || !here.open.includes(id)) return history;
  const entries = [...history.entries];
  entries[history.at] = { ...here, scroll: { ...here.scroll, [id]: top } };
  return { entries, at: history.at };
}

export const canBack = (history: DockHistory): boolean => history.at > 0;
export const canForward = (history: DockHistory): boolean =>
  history.at < history.entries.length - 1;

export const back = (history: DockHistory): DockHistory =>
  canBack(history) ? { entries: history.entries, at: history.at - 1 } : history;
export const forward = (history: DockHistory): DockHistory =>
  canForward(history) ? { entries: history.entries, at: history.at + 1 } : history;
