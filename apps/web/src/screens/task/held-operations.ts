// SPDX-License-Identifier: AGPL-3.0-only
//
// The operation ids of writes whose answer was lost, by request (#461). The
// task page holds them above its read, so a reread that remounts its add
// boxes retries the same request under the same id and the server keeps one
// record. Outside the page (the dock panel) each box keeps its own. Keys
// name their command, so one box's words never reach another's id, and an
// answer releases its key only while the key still holds its own id.

import { createContext, use, useRef } from 'react';
import type { CommentCustody } from './comment-custody.ts';

export type Held = Record<string, string | undefined>;

export const HeldOperations = createContext<Held | null>(null);

/** Exact post/reply custody is App-owned, above the page's local held-ID provider. */
export const HeldComments = createContext<CommentCustody | null>(null);

/** The page's held ids where it holds them, else this box's own. */
export function useHeldOperations(): Held {
  const own = useRef<Held>({});
  return use(HeldOperations) ?? own.current;
}

/**
 * A request's held id, keyed by its command and words and minted when none is
 * held, and its settling: a known answer releases the key only while the key
 * still holds this id.
 */
export function holding(held: Held, command: string, words: unknown, mint: () => string) {
  const key = `${command} ${JSON.stringify(words)}`;
  const id = (held[key] ??= mint());
  const settle = (kind: string): void => {
    if (kind !== 'unknown' && held[key] === id) held[key] = undefined;
  };
  return { id, settle };
}
