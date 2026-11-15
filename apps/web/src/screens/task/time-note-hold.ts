// SPDX-License-Identifier: AGPL-3.0-only
//
// The time note's held operation id (`Time.tsx`, #1455).

import type { Held } from './held-operations.ts';

/**
 * One held note per entry: the same words sent again over the same note, after
 * a lost answer, go under the held id; other words, or a note read back changed
 * since, replace it, so a note typed back later is a new save, never a replay
 * of an earlier one's stored answer.
 */
export function noteHold(
  held: Held,
  body: { entryId: string; note: string },
  over: string,
  mint: () => string,
) {
  const slot = `time.set_note ${body.entryId}`;
  const words = `${slot} words`;
  const said = JSON.stringify([over, body.note]);
  const id = held[words] === said ? (held[slot] ?? mint()) : mint();
  held[slot] = id;
  held[words] = said;
  const settle = (kind: string): void => {
    if (kind === 'unknown' || held[slot] !== id) return;
    held[slot] = undefined;
    held[words] = undefined;
  };
  return { id, settle };
}
