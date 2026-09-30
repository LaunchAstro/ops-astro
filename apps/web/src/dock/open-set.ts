// SPDX-License-Identifier: AGPL-3.0-only
//
// THE DOCK'S OPEN SET: which panels are open, where each one is, and what the
// tab keeps of it for whom.
//
// `open` is kept in the order the panels were opened, because Escape takes the
// last one opened. The layout never reads that order: it draws `ranked`, the
// declared rank, so a panel's position does not depend on when it was opened.
//
// A panel's place is the address of the view inside it, such as the task a
// list was walked into. It is what the panel's door carries, and it is dropped
// with the panel: the X, Close all and Escape leave no place behind, so a
// closed Task panel leaves no stored open-task row.
//
// **The stored row belongs to one person in one business.** It is kept under
// the business's key and names the person it was written for, so a tab that
// changes business, or passes to another person, restores nothing of the
// last one's dock. The sign-in id is never part of it. Sign-out removes it.

import { PANEL_RANK, isPanelId, type PanelId } from '../panels.ts';
import { dockKey, isRecord, jsonSlot, type Session, type StorageLike } from '../session/token.ts';

export interface DockState {
  /** Open panels, in the order they were opened. */
  readonly open: readonly PanelId[];
  /** Each open panel's view, as an address this application owns. Absent means its board. */
  readonly places: { readonly [Id in PanelId]?: string };
}

export const CLOSED: DockState = Object.freeze({ open: [], places: {} });

/** The open panels in declared rank, the order they are drawn in. */
export const ranked = (state: DockState): readonly PanelId[] =>
  PANEL_RANK.filter((id) => state.open.includes(id));

/** The state with only `ids` open, each keeping its place. */
export function only(state: DockState, ids: readonly PanelId[]): DockState {
  const places: { [Id in PanelId]?: string } = {};
  for (const id of ids) {
    const place = state.places[id];
    if (place !== undefined) places[id] = place;
  }
  return { open: ids, places };
}

export const close = (state: DockState, id: PanelId): DockState =>
  state.open.includes(id)
    ? only(
        state,
        state.open.filter((each) => each !== id),
      )
    : state;

export const closeAll = (state: DockState): DockState => (state.open.length === 0 ? state : CLOSED);

/** Escape: the panel opened last, one per press. */
export const escape = (state: DockState): DockState => {
  const last = state.open.at(-1);
  return last === undefined ? state : close(state, last);
};

/**
 * A press on a dock tab. Plain shows this panel alone, and on the only open
 * panel closes it; shift adds this panel beside the rest, or takes it away.
 */
export function press(state: DockState, id: PanelId, shift: boolean): DockState {
  const isOpen = state.open.includes(id);
  if (shift) return isOpen ? close(state, id) : { ...state, open: [...state.open, id] };
  if (isOpen && state.open.length === 1) return close(state, id);
  return only(state, [id]);
}

/**
 * An open from anywhere but the tab: a row, a route, a door, a badge. Plain
 * shows the target alone and shift stacks it, like the tab; a target already
 * open is left where it is and only its place moves, because the click was
 * changing the view inside it.
 */
export function openByGesture(
  state: DockState,
  id: PanelId,
  shift: boolean,
  place?: string,
): DockState {
  const opened = state.open.includes(id)
    ? state
    : shift
      ? { ...state, open: [...state.open, id] }
      : only(state, [id]);
  return place === undefined ? opened : visit(opened, id, place);
}

/** The panel's view moved inside it. */
export const visit = (state: DockState, id: PanelId, place: string): DockState =>
  state.open.includes(id) ? { ...state, places: { ...state.places, [id]: place } } : state;

/** The panels one change closed, in the order they had been opened. */
export const closedBy = (before: DockState, after: DockState): readonly PanelId[] =>
  before.open.filter((id) => !after.open.includes(id));

/**
 * Whether something inside the page already owns this Escape: a field, a
 * menu, an editor, or a handler that took it. The dock then closes nothing.
 */
export function handledInside(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return true;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  return target.closest(OWNS_ESCAPE) !== null;
}

const OWNS_ESCAPE = [
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false" i])',
  '[role="textbox" i]',
  '[role="combobox" i]',
  '[role="listbox" i]',
  '[role="menu" i]',
  '[role="menubar" i]',
  '[role="dialog" i]',
].join(', ');

/** An address this application owns: a path, never another origin. */
export const isOwnAddress = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.startsWith('/') &&
  !value.startsWith('//') &&
  !value.startsWith('/\\') &&
  // oxlint-disable-next-line no-control-regex -- refusing control characters is the point
  !/[\u0000-\u001F\\]/u.test(value);

interface StoredDock {
  readonly who: string;
  readonly open: readonly unknown[];
  readonly places: Readonly<Record<string, unknown>>;
}

const isStoredDock = (value: unknown): value is StoredDock =>
  isRecord(value) &&
  typeof value['who'] === 'string' &&
  Array.isArray(value['open']) &&
  isRecord(value['places']) &&
  !Array.isArray(value['places']);

export interface DockSlot {
  readonly read: () => DockState;
  readonly write: (state: DockState) => void;
}

/** The tab's copy of one person's dock in one business. No session, no copy. */
export function dockSlot(storage: StorageLike | null, session: Session | null): DockSlot {
  if (session === null) return { read: () => CLOSED, write: () => {} };
  const slot = jsonSlot(storage, dockKey(session.businessKey), isStoredDock);
  return {
    read: () => {
      const stored = slot.read();
      if (stored === null || stored.who !== session.email) return CLOSED;
      const open: PanelId[] = [];
      for (const id of stored.open) {
        if (typeof id === 'string' && isPanelId(id) && !open.includes(id)) open.push(id);
      }
      const places: { [Id in PanelId]?: string } = {};
      for (const id of open) {
        const place = Object.hasOwn(stored.places, id) ? stored.places[id] : undefined;
        if (isOwnAddress(place)) places[id] = place;
      }
      return { open, places };
    },
    write: (state) => {
      if (state.open.length === 0) {
        slot.remove();
        return;
      }
      slot.write({ who: session.email, open: state.open, places: state.places });
    },
  };
}
