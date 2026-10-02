// SPDX-License-Identifier: AGPL-3.0-only
//
// The person's rail and dock sizes (MP-2-3, MP-3-2, MP-3-3) as MP-2-11's one
// preference store keeps them: `rail.width`, `rail.collapsed`, `dock.width` and
// `dock.sheetHeight`, read with `preference.read` and written with
// `preference.save`, which reach the caller's own row and no one else's (the
// server's rule, tests/api/preferences.test.ts). Neither is audited (CS-2.8).
//
// The tab keeps a copy, per business and naming its person, as the dock keeps
// its open set: a reload draws the layout on its first render, so nothing
// jumps, and the read then brings what another device saved. Another person
// signed in to the tab never reads the copy, and a switch or sign-out removes
// it (session/token.ts). A key is saved once per release or fold, never per
// move: the rail and the dock hold a moving value themselves.

import { useEffect, useRef, useState } from 'react';
import type { OperationsClient } from '../operations/client.ts';
import {
  grantKeyOf,
  isRecord,
  jsonSlot,
  layoutKey,
  sessionGeneration,
  type Session,
  type StorageLike,
} from '../session/token.ts';

const KEYS = ['rail.width', 'rail.collapsed', 'dock.width', 'dock.sheetHeight'] as const;
export type LayoutKey = (typeof KEYS)[number];
/** The stored keys as they arrived: each part checks its own value's shape. */
export type Layout = Readonly<Partial<Record<LayoutKey, unknown>>>;

export interface LayoutStore {
  readonly layout: Layout;
  readonly save: (key: LayoutKey, value: number | boolean) => void;
}

/** The layout keys of a stored record, and nothing else of it. */
function layoutIn(value: unknown): Layout {
  if (!isRecord(value)) return {};
  const layout: Partial<Record<LayoutKey, unknown>> = {};
  for (const key of KEYS) if (Object.hasOwn(value, key)) layout[key] = value[key];
  return layout;
}

function tabCopy(storage: StorageLike | null, session: Session | null) {
  const slot =
    session === null ? null : jsonSlot(storage, layoutKey(session.businessKey), isRecord);
  return {
    read: (): Layout => {
      const kept = slot?.read();
      return kept?.['who'] === session?.email ? layoutIn(kept?.['layout']) : {};
    },
    write: (layout: Layout): void => {
      slot?.write({ who: session?.email, layout });
    },
  };
}

export function useLayoutStore(
  client: OperationsClient,
  session: Session | null,
  storage: StorageLike | null,
): LayoutStore {
  const owner = grantKeyOf(session);
  const copy = tabCopy(storage, session);
  const [held, setHeld] = useState(() => ({ owner, layout: copy.read() }));
  // Another person, business or sign-in is another layout: read theirs.
  const current = held.owner === owner ? held : { owner, layout: copy.read() };
  if (current !== held) setHeld(current);
  // Keys saved here since the read left: its answer does not undo them.
  const savedHere = useRef<{ owner: string; layout: Layout }>({ owner, layout: {} });
  if (savedHere.current.owner !== owner) savedHere.current = { owner, layout: {} };

  useEffect(() => {
    if (session === null) return;
    let live = true;
    const generation = sessionGeneration();
    void client.read<{ readonly preferences?: unknown }>('preference.read', {}).then((answer) => {
      if (!live || generation !== sessionGeneration() || !('value' in answer)) return answer;
      const layout = { ...layoutIn(answer.value.preferences), ...savedHere.current.layout };
      tabCopy(storage, session).write(layout);
      setHeld({ owner: grantKeyOf(session), layout });
      return answer;
    });
    return () => {
      live = false;
    };
  }, [client, session, storage]);

  return {
    layout: current.layout,
    save: (key, value) => {
      if (session === null) return;
      savedHere.current = { owner, layout: { ...savedHere.current.layout, [key]: value } };
      const layout = { ...current.layout, [key]: value };
      copy.write(layout);
      setHeld({ owner, layout });
      void client.mutate('preference.save', { preference: key, value });
    },
  };
}
