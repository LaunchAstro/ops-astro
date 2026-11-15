// SPDX-License-Identifier: AGPL-3.0-only
//
// The operation ids of writes whose answer was lost, by request (#461). The
// task page holds them above its read, so a reread that remounts its add
// boxes retries the same request under the same id and the server keeps one
// record. Outside the page (the dock panel) each box keeps its own. Keys
// name their command, so one box's words never reach another's id, and an
// answer releases its key only while the key still holds its own id.
//
// The page also holds its last answer drawn while a box under it is open
// (`KeepTaskRead`), so a save's reread does not take the box's newer words.

import { createContext, use, useCallback, useEffect, useRef, useState } from 'react';
import type { CommentCustody } from './comment-custody.ts';

export type Held = Record<string, string | undefined>;

export const HeldOperations = createContext<Held | null>(null);

/** Exact post/reply custody is App-owned, above the page's local held-ID provider. */
export const HeldComments = createContext<CommentCustody | null>(null);

/**
 * The task page's hold on its last answer: a box open under it takes one, and
 * while any is taken a reread keeps the page drawn, so words typed after a save
 * outlive that save's reread. Outside the page there is nothing to hold.
 */
export const KeepTaskRead = createContext<(() => () => void) | null>(null);

/** The page's side: the hold to provide, and whether any box holds it now. */
export function useKeepTaskRead() {
  const [open, setOpen] = useState(0);
  const take = useCallback(() => {
    setOpen((was) => was + 1);
    return () => {
      setOpen((was) => was - 1);
    };
  }, []);
  return { take, kept: open > 0 };
}

/** A box's side: hold the page's answer drawn while `open`. */
export function useHoldTaskRead(open: boolean): void {
  const take = use(KeepTaskRead);
  useEffect(() => (open && take !== null ? take() : undefined), [open, take]);
}

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
