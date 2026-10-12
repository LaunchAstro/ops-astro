// SPDX-License-Identifier: AGPL-3.0-only
//
// What is typed in the graduation region (MP-14-10a), held above its read so a
// reread that fails gives it back. The region keeps the chosen client; each
// client keeps its own drafts, and the forms read only the chosen client's,
// so one client's typed standing mandate can never be filed for another. Every
// change of client, the fallback when the chosen one leaves the read included,
// goes through `choose`, which starts every client's drafts over.

import { createContext, useContext, useEffect, useState } from 'react';

/** The drafts the forms read: the chosen client's, inside the region's own. */
export const Drafts = createContext(new Map<string, unknown>());

/**
 * A field's value, kept in the drafts under `key` from its first draw, so what
 * comes back after an outage is what was on screen.
 */
export function useDraft<T>(key: string, initial: T): readonly [T, (next: T) => void] {
  const drafts = useContext(Drafts);
  const [value, setValue] = useState(() => {
    if (!drafts.has(key)) drafts.set(key, initial);
    return drafts.get(key) as T;
  });
  const set = (next: T): void => {
    drafts.set(key, next);
    setValue(next);
  };
  return [value, set];
}

/** `id`'s own drafts within the region's. */
function draftsOf(region: Map<string, unknown>, id: string): Map<string, unknown> {
  const key = `client:${id}`;
  const held = region.get(key);
  if (held instanceof Map) return held as Map<string, unknown>;
  const fresh = new Map<string, unknown>();
  region.set(key, fresh);
  return fresh;
}

/**
 * The client shown, how to choose another, and the shown client's drafts.
 * Choosing withdraws the write in flight (`drop`) and starts every client's
 * drafts over. A chosen client the read no longer has falls back to the first,
 * chosen the same way; until then the first is shown with its own drafts, so
 * nothing typed for the one that left is ever under it.
 */
export function useChosen(
  ids: readonly string[],
  drop: () => void,
): readonly [string | undefined, (id: string) => void, Map<string, unknown>] {
  const region = useContext(Drafts);
  const [chosen, setChosen] = useDraft('client', ids[0] ?? '');
  const choose = (id: string): void => {
    drop();
    region.clear();
    setChosen(id);
  };
  const shown = ids.includes(chosen) ? chosen : ids[0];
  useEffect(() => {
    if (shown !== undefined && shown !== chosen) choose(shown);
  });
  return [shown, choose, draftsOf(region, shown ?? '')];
}

/** The row whose promotion form is open; opening or closing one forgets what was typed in it. */
export function usePromoting(): readonly [string | null, (id: string | null) => void] {
  const drafts = useContext(Drafts);
  const [promoting, setPromoting] = useDraft<string | null>('promoting', null);
  const open = (id: string | null): void => {
    drafts.delete('promote:ceiling');
    drafts.delete('promote:expiry');
    setPromoting(id);
  };
  return [promoting, open];
}
