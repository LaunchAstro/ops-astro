// SPDX-License-Identifier: AGPL-3.0-only
//
// Show or hide finished subtasks (MP-4-4, CS-4.27, `preference saved`, not
// audited): the person's own key in the one preference store (MP-2-11a),
// `subtasks.showFinished`, read once and saved on each change. Hidden is the
// default and the absence of a row. A reader the store refuses (no grant, an
// external party) keeps the choice as view state and sends no save, so a
// click never leaves a refused write behind.

import { useEffect, useState } from 'react';
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

export function useShowFinished(
  client: OperationsClient,
): readonly [boolean, (next: boolean) => void] {
  const [shown, setShown] = useState(false);
  const [stored, setStored] = useState(false);

  useEffect(() => {
    let current = true;
    client
      .read<unknown>('preference.read', {})
      .then((answer) => {
        if (!current || !('value' in answer)) return answer;
        setStored(true);
        const choice = storedChoice(answer.value);
        if (choice !== null) setShown(choice);
        return answer;
      })
      .catch(() => null);
    return () => {
      current = false;
    };
  }, [client]);

  const choose = (next: boolean): void => {
    setShown(next);
    if (stored) void client.mutate('preference.save', { preference: SHOW_FINISHED, value: next });
  };
  return [shown, choose];
}
