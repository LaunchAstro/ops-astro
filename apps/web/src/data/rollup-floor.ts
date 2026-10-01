// SPDX-License-Identifier: AGPL-3.0-only
//
// C4 CS-1.2: the floor for pages no topic reaches, the agency-wide rollups
// ("two topic shapes and no third", LIVE-SYNC.md). They re-read every 30 s
// while the tab is visible, at once when it is shown again or comes back
// online, and not at all while hidden.

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

export function createRollupFloor({
  visible = () => document.visibilityState === 'visible',
}: HubOptions = {}): RollupFloor {
  return new Floor(visible);
}
