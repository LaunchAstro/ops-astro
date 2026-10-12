// SPDX-License-Identifier: AGPL-3.0-only
//
// Runs the board streams of one credential share (#620). One task event wakes
// every open board at once, and each would check the bearer and read the same
// admission and digests. A run waits `GATHER_MS` before it begins, and a board
// shares it only while it has not begun: the shared answers are then asked
// after every sharer's own run started, exactly as each would have asked them
// itself (ORCH46). A board that asks once the run has begun asks its own, and
// nothing is kept after it.

import { setTimeout as delay } from 'node:timers/promises';

/** How long a run waits for the other boards before it begins: one still finishing its previous run. */
export const GATHER_MS = 50;

export type Gather = <T>(key: string, ask: () => Promise<T>) => Promise<T>;

export function createGather(): Gather {
  const waiting = new Map<string, Promise<unknown>>();
  return async function gather<T>(key: string, ask: () => Promise<T>): Promise<T> {
    const joined = waiting.get(key) as Promise<T> | undefined;
    if (joined !== undefined) return await joined;
    const run = delay(GATHER_MS).then(async () => {
      waiting.delete(key);
      return await ask();
    });
    waiting.set(key, run);
    return await run;
  };
}
