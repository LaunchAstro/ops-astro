// SPDX-License-Identifier: AGPL-3.0-only
//
// This tab's own place in its history, for the app strip's Back and Forward
// (MP-2-5). The browser says neither whether there is a page ahead nor where
// the tab is, so each entry the application pushes carries its position, and
// the furthest position is kept for the tab. A new navigation from the middle
// drops the pages ahead, as the browser does, so Forward is disabled then
// (TR-S-B1R-13).

const TOP = 'ops-astro.history-top';

/** The parts of the browser window this reads and writes. */
export interface HistoryWindow {
  readonly history: History;
  readonly sessionStorage: Storage;
}

const positionOf = (state: unknown): number | null => {
  const at = (state as { readonly at?: unknown } | null)?.at;
  return typeof at === 'number' && Number.isInteger(at) && at >= 0 ? at : null;
};

export class TabHistory {
  #at: number;
  #top: number;
  readonly #window: HistoryWindow;

  constructor(window: HistoryWindow) {
    this.#window = window;
    const held = positionOf(window.history.state);
    this.#at = held ?? 0;
    this.#top = Math.max(this.#at, this.#readTop() ?? this.#at);
    if (held === null) window.history.replaceState({ at: this.#at }, '');
  }

  get canBack(): boolean {
    return this.#at > 0;
  }

  get canForward(): boolean {
    return this.#at < this.#top;
  }

  /** A new page: pushed after this one, and every page ahead is gone. */
  push(address: string): void {
    this.#at += 1;
    this.#top = this.#at;
    this.#window.history.pushState({ at: this.#at }, '', address);
    this.#writeTop();
  }

  /** The same page under its corrected address: no new entry. */
  replace(address: string): void {
    this.#window.history.replaceState({ at: this.#at }, '', address);
  }

  /** The browser moved within the tab's history; `state` is the entry it landed on. */
  moved(state: unknown): void {
    this.#at = positionOf(state) ?? 0;
    this.#top = Math.max(this.#top, this.#at);
  }

  #readTop(): number | null {
    try {
      const value = Number(this.#window.sessionStorage.getItem(TOP));
      return Number.isInteger(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  }

  #writeTop(): void {
    try {
      this.#window.sessionStorage.setItem(TOP, String(this.#top));
    } catch {
      // Blocked site data: the position still holds for this page's life.
    }
  }
}
