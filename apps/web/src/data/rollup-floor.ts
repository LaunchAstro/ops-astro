// SPDX-License-Identifier: AGPL-3.0-only
//
// C4 CS-1.2: the floor for pages no topic reaches, the agency-wide rollups
// ("two topic shapes and no third", LIVE-SYNC.md). They re-read every 30 s
// while the tab is visible, at once when it is shown again or comes back
// online, and not at all while hidden.

import { useEffect } from 'react';
import type { AuthorisedRead } from './authorised-read.ts';
import { FLOOR_MS, type HubOptions } from './live.ts';

/** The floor for pages no topic reaches (C4 CS-1.2): agency-wide rollups. */
export interface RollupFloor {
  /** Re-read on the floor until the returned function is called. */
  follow(onRefresh: () => void): () => void;
}

/**
 * One timer for every rollup on the tab, running only while the tab is
 * visible: each page re-reads every 30 s, at once on becoming visible again
 * and on coming back online, and a hidden tab runs no timer for them.
 */
class Floor implements RollupFloor {
  readonly #followers = new Set<() => void>();
  #timer: ReturnType<typeof setInterval> | undefined;
  readonly #visible: () => boolean;

  constructor(visible: () => boolean) {
    this.#visible = visible;
  }

  follow(onRefresh: () => void): () => void {
    const first = this.#followers.size === 0;
    const own = (): void => onRefresh();
    this.#followers.add(own);
    if (first) this.#listen(true);
    return () => {
      this.#followers.delete(own);
      if (this.#followers.size === 0) this.#listen(false);
    };
  }

  readonly #tell = (): void => {
    for (const onRefresh of this.#followers) onRefresh();
  };

  readonly #shown = (): void => {
    clearInterval(this.#timer);
    this.#timer = undefined;
    if (!this.#visible()) return;
    this.#tell();
    this.#timer = setInterval(this.#tell, FLOOR_MS);
  };

  readonly #online = (): void => {
    if (this.#visible()) this.#tell();
  };

  #listen(on: boolean): void {
    const method = on ? 'addEventListener' : 'removeEventListener';
    document[method]('visibilitychange', this.#shown);
    window[method]('online', this.#online);
    clearInterval(this.#timer);
    this.#timer = on && this.#visible() ? setInterval(this.#tell, FLOOR_MS) : undefined;
  }
}

let tab: RollupFloor | undefined;

/** The tab's one floor, shared by every rollup page drawn on it. */
export function tabRollupFloor(): RollupFloor {
  tab ??= createRollupFloor();
  return tab;
}

export function createRollupFloor({
  visible = () => document.visibilityState === 'visible',
}: HubOptions = {}): RollupFloor {
  return new Floor(visible);
}

/**
 * How long a read in flight is waited for before a floor tick asks again:
 * three floors, less half of one, so a tick that runs a little early still
 * counts as the fourth.
 */
const ROLLUP_PATIENCE_MS = 3 * FLOOR_MS - FLOOR_MS / 2;

/**
 * Re-read on the rollup floor (C4 CS-1.2). A tick waits for the read in flight
 * rather than superseding it: a newer read would retire its answer, so reads
 * slower than the floor would never land.
 *
 * Given the projection, reads have no transport timeout, so a read still in
 * flight `ROLLUP_PATIENCE_MS` after a tick first found it is superseded, and a
 * revoke still draws. The wait is time on the monotonic clock, so tab-shows do
 * not shorten it, and every re-read (`waitedFrom` is cleared by `reread`)
 * starts it again.
 *
 * Given the read in flight instead (`coalesce`), the run bounds its own time:
 * a tick that finds it sets one follow-up, started when it ends unless another
 * read has begun by then, and never supersedes it.
 */
export function useRollup<T>(
  rollup: RollupFloor | undefined,
  inFlight:
    { readonly current: AuthorisedRead<T> | null } | { readonly current: Promise<void> | null },
  waitedFrom: { current: number | null },
  reload: () => void,
): void {
  useEffect(() => {
    let following = false;
    return rollup?.follow(() => {
      const now = inFlight.current;
      if (now instanceof Promise) {
        if (following) return;
        following = true;
        void now.finally(() => {
          following = false;
          if (inFlight.current === null) reload();
        });
        return;
      }
      if (now?.state.outcome === 'loading') {
        const at = performance.now();
        waitedFrom.current ??= at;
        if (at - waitedFrom.current < ROLLUP_PATIENCE_MS) return;
      }
      reload();
    });
  }, [rollup, inFlight, waitedFrom, reload]);
}
