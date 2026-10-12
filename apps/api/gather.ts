// SPDX-License-Identifier: AGPL-3.0-only
//
// Runs the board streams of one credential share (#620). One task event wakes
// every open board at once, and each would check the bearer and read the same
// admission and digests. A board shares a run another board began only when
// that run began after the signal this board is answering, so the answer is
// never older than its signal; otherwise it begins its own. A run is joinable
// for `KEEP_MS` after it settles and kept no longer.

import { performance } from 'node:perf_hooks';

/** How long a settled run stays joinable: a board a moment behind, still finishing its previous run. */
export const KEEP_MS = 1_000;

/** `ask`, or the run under `key` that began after `since` (a `performance.now()` stamp). */
export type Gather = <T>(key: string, since: number, ask: () => Promise<T>) => Promise<T>;

export function createGather(): Gather {
  const runs = new Map<string, { readonly begunAt: number; readonly answer: Promise<unknown> }>();
  return async function gather<T>(key: string, since: number, ask: () => Promise<T>): Promise<T> {
    const held = runs.get(key);
    if (held !== undefined && held.begunAt > since) return (await held.answer) as T;
    const run = { begunAt: performance.now(), answer: ask() };
    runs.set(key, run);
    const forget = (): void => {
      setTimeout(() => {
        if (runs.get(key) === run) runs.delete(key);
      }, KEEP_MS).unref();
    };
    run.answer.then(forget, forget);
    return await run.answer;
  };
}
