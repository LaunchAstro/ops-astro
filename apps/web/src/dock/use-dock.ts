// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock's state as the application holds it: one person's open set in one
// business, read from the tab when that session arrives, written back on every
// change, and each closed panel's tenant told it closed.
//
// A change is computed from the value in hand, not inside a state updater, so
// a tenant's close runs once per close even where React runs updaters twice.

import { useCallback, useEffect, useRef, useState } from 'react';
import { dockTabs, type PanelRegistry } from '../panels.ts';
import { grantKeyOf, type Session, type StorageLike } from '../session/token.ts';
import { closedBy, dockSlot, escape, handledInside, only, type DockState } from './open-set.ts';

export interface DockModel {
  readonly state: DockState;
  readonly change: (next: (state: DockState) => DockState) => void;
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

  return { state: current.state, change };
}
