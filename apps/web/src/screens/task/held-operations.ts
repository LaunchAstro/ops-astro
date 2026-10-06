// SPDX-License-Identifier: AGPL-3.0-only
//
// The operation ids of writes whose answer was lost, by request (#461). The
// task page holds them above its read, so a reread that remounts its add
// boxes retries the same request under the same id and the server keeps one
// record. Outside the page (the dock panel) each box keeps its own.

import { createContext, use, useRef } from 'react';

export type Held = Record<string, string | undefined>;

export const HeldOperations = createContext<Held | null>(null);

/** The page's held ids where it holds them, else this box's own. */
export function useHeldOperations(): Held {
  const own = useRef<Held>({});
  return use(HeldOperations) ?? own.current;
}
