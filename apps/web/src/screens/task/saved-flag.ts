// SPDX-License-Identifier: AGPL-3.0-only
//
// One true-or-false choice the person makes on a task screen, kept as their
// own key in the one preference store (MP-2-11a, `preference saved`, not
// audited): read once and saved on each change. False is the default and the
// absence of a row. A reader the store refuses (no grant, an external party)
// keeps the choice as view state and sends no save, so a click never leaves a
// refused write behind. Show finished subtasks (`show-finished.ts`) and the
// panel's trail fold (`history.showTrail`) are two such keys.
//
// **A choice made before the store answers stands.** The store's late answer
// does not overwrite it; it is saved then, if the store keeps this reader.
// Saves leave in click order, each after the last has answered
// (`preference-saves.ts`), so the store keeps the last click.
//
// **The caller may hold the value above its read** (`hold`), as the task page
// holds its other view state, so a reread that remounts the control keeps the
// choice as the person left it. The store seeds the hold only while it is empty.

import { useEffect, useRef, useState } from 'react';
import { savePreference } from '../../data/preference-saves.ts';
import type { OperationsClient } from '../../operations/client.ts';

/** The stored choice under `key` in a `preference.read` answer, or null when none is stored. */
function storedChoice(value: unknown, key: string): boolean | null {
  if (typeof value !== 'object' || value === null) return null;
  const preferences = (value as { readonly preferences?: unknown }).preferences;
  if (typeof preferences !== 'object' || preferences === null) return null;
  const held = (preferences as Readonly<Record<string, unknown>>)[key];
  return typeof held === 'boolean' ? held : null;
}

/** The value kept by the caller, above a read that may remount the control. */
export type SavedFlagHold = readonly [boolean | null, (next: boolean | null) => void];

export function useSavedFlag(
  client: OperationsClient,
  key: string,
  hold?: SavedFlagHold,
): readonly [boolean, (next: boolean) => void] {
  const local = useState<boolean | null>(null);
  const [held, setHeld] = hold ?? local;
  const [stored, setStored] = useState(false);
  // What the person chose while the store had not answered yet, and the
  // latest hold and setter for the answer to read when it lands.
  const chosen = useRef<boolean | null>(null);
  const latest = useRef({ held, setHeld });
  latest.current = { held, setHeld };

  useEffect(() => {
    let current = true;
    client
      .read<unknown>('preference.read', {})
      .then((answer) => {
        if (!current || !('value' in answer)) return answer;
        setStored(true);
        if (chosen.current !== null) {
          void savePreference(client, key, chosen.current);
        } else if (latest.current.held === null) {
          latest.current.setHeld(storedChoice(answer.value, key) ?? false);
        }
        return answer;
      })
      .catch(() => null);
    return () => {
      current = false;
    };
  }, [client, key]);

  const choose = (next: boolean): void => {
    setHeld(next);
    if (stored) void savePreference(client, key, next);
    else chosen.current = next;
  };
  return [held ?? false, choose];
}
