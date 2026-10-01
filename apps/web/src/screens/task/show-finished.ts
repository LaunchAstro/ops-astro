// SPDX-License-Identifier: AGPL-3.0-only
//
// Show or hide finished subtasks (MP-4-4, CS-4.27, `preference saved`, not
// audited): the person's own key in the one preference store (MP-2-11a),
// `subtasks.showFinished`, read once and saved on each change. Hidden is the
// default and the absence of a row. A reader the store refuses (no grant, an
// external party) keeps the choice as view state and sends no save, so a
// click never leaves a refused write behind.
//
// **A choice made before the store answers stands.** The store's late answer
// does not overwrite it; it is saved then, if the store keeps this reader.
//
// **The task page holds the value above its read** (`hold`), as it holds its
// other view state, so a reread that remounts the subtasks keeps the fold as
// the person left it. The store seeds the hold only while it is empty.

import { useEffect, useRef, useState } from 'react';
import type { OperationsClient } from '../../operations/client.ts';

export const SHOW_FINISHED = 'subtasks.showFinished';

/** The stored choice in a `preference.read` answer, or null when none is stored. */
function storedChoice(value: unknown): boolean | null {
  if (typeof value !== 'object' || value === null) return null;
  const preferences = (value as { readonly preferences?: unknown }).preferences;
  if (typeof preferences !== 'object' || preferences === null) return null;
  const held = (preferences as Readonly<Record<string, unknown>>)[SHOW_FINISHED];
  return typeof held === 'boolean' ? held : null;
}

/** The shown value kept by the caller, above a read that may remount this. */
export type ShowFinishedHold = readonly [boolean | null, (next: boolean | null) => void];

export function useShowFinished(
  client: OperationsClient,
  hold?: ShowFinishedHold,
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
          void client.mutate('preference.save', {
            preference: SHOW_FINISHED,
            value: chosen.current,
          });
        } else if (latest.current.held === null) {
          latest.current.setHeld(storedChoice(answer.value) ?? false);
        }
        return answer;
      })
      .catch(() => null);
    return () => {
      current = false;
    };
  }, [client]);

  const choose = (next: boolean): void => {
    setHeld(next);
    if (stored) void client.mutate('preference.save', { preference: SHOW_FINISHED, value: next });
    else chosen.current = next;
  };
  return [held ?? false, choose];
}
