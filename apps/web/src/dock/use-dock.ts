// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock's state as the application holds it: one person's open set in one
// business, read from the tab when that session arrives, written back on every
// change, and each closed panel's tenant told it closed.
//
// A change is computed from the value in hand, not inside a state updater, so
// a tenant's close runs once per close even where React runs updaters twice.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { dockTabs, isPanelId, type PanelRegistry } from '../panels.ts';
import { grantKeyOf, type Session, type StorageLike } from '../session/token.ts';
import {
  closedBy,
  dockSlot,
  escape,
  handledInside,
  isOwnAddress,
  only,
  openByGesture,
  type DockState,
} from './open-set.ts';

export interface DockModel {
  readonly state: DockState;
  readonly change: (next: (state: DockState) => DockState) => void;
  /** Every click inside the application, for the doors into the dock. */
  readonly onDoor: (event: ReactMouseEvent<HTMLElement>) => void;
}

export function useDock(
  session: Session | null,
  storage: StorageLike | null,
  registry: PanelRegistry,
): DockModel {
  const owner = grantKeyOf(session);
  // A stored id whose panel has no tab here is not restored: it would draw
  // nothing and still take an Escape.
  const restore = (): DockState => {
    const stored = dockSlot(storage, session).read();
    const tabs = new Set(dockTabs({}, registry).map((tab) => tab.id));
    return only(
      stored,
      stored.open.filter((id) => tabs.has(id)),
    );
  };
  const [held, setHeld] = useState(() => ({ owner, state: restore() }));
  // Another person, business or sign-in is another dock: read theirs, never
  // carry this one across.
  const current = held.owner === owner ? held : { owner, state: restore() };
  if (current !== held) setHeld(current);
  const ref = useRef(current);
  ref.current = current;

  const change = useCallback(
    (next: (state: DockState) => DockState) => {
      const before = ref.current;
      const after = next(before.state);
      if (after === before.state) return;
      const moved = { owner: before.owner, state: after };
      ref.current = moved;
      dockSlot(storage, session).write(after);
      setHeld(moved);
      for (const id of closedBy(before.state, after)) registry[id]?.onClose?.();
    },
    [storage, session, registry],
  );

  // Escape closes the last opened panel, one per press, and never an Escape
  // that a field, menu or editor already owns. The drawer, which closes first,
  // arrives with MP-2-8.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || handledInside(event)) return;
      if (ref.current.state.open.length === 0) return;
      event.preventDefault();
      change(escape);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [change]);

  // Every other door into the dock obeys the same law as the tab (MP-3-4): a
  // row, a route, a badge, a task icon declares `data-dock-open` and may name
  // the view with `data-dock-place`; the ask seam declares `data-ask` and opens
  // the assistant. Plain solos, shift stacks, and a target already open stays
  // open while its view moves. A click another handler took is left alone.
  // Heard on the application's own root, so a door answers to its own dock.
  const onDoor = useCallback(
    (event: ReactMouseEvent<HTMLElement>): void => {
      if (event.defaultPrevented || event.button !== 0) return;
      const door =
        event.target instanceof Element
          ? event.target.closest('[data-dock-open], [data-ask]')
          : null;
      if (door === null) return;
      const id = door.getAttribute('data-dock-open') ?? 'ai';
      if (!isPanelId(id) || !dockTabs({}, registry).some((tab) => tab.id === id)) return;
      const place = door.getAttribute('data-dock-place');
      event.preventDefault();
      change((state) =>
        openByGesture(state, id, event.shiftKey, isOwnAddress(place) ? place : undefined),
      );
    },
    [change, registry],
  );

  return { state: current.state, change, onDoor };
}
