// SPDX-License-Identifier: AGPL-3.0-only
//
// What a look probe is (UI-POLISH). Its own module, so the screen files and
// the list in index.ts each import it and never each other.

import type { MadeUpVariant } from '../made-up-api.ts';

/**
 * Before measuring: `store` puts values in the page's localStorage before it
 * loads (a state the mockup replays before paint, such as its dragged rail
 * width), and `drag` moves an element's centre by `by` pixels along x with
 * the pointer, the way a person drags an edge.
 */
export interface LookPrep {
  readonly open?: string | readonly string[];
  readonly store?: Readonly<Record<string, string>>;
  readonly drag?: { readonly selector: string; readonly by: number };
}

export interface LookProbe {
  /** `<screen>.<element>`, unique across screens. */
  readonly id: string;
  /** The mockup page path and the element there; `open` clicks, in turn, before measuring. */
  readonly mockup: LookPrep & { readonly path: string; readonly selector: string };
  /** The app page (drawn from the made-up reads) and the element there. */
  readonly app: LookPrep & {
    readonly page: string;
    readonly selector: string;
    /**
     * An address to draw instead of the page's, signed in: a held address, an
     * unknown one, or sign-in with a session already held.
     */
    readonly path?: string;
    /** The made-up reads in another state (`made-up-api.ts`): a read's other renderings. */
    readonly reads?: MadeUpVariant;
  };
  /**
   * Computed style properties (colours compared as painted), or
   * `box.width|height|x|y`, or `box.drawn`: whether it paints any area at all.
   */
  readonly props: readonly string[];
  /**
   * Where a ruling moved the build off the mockup: `at` is `<prop>@<theme>`,
   * `want` the value the build holds, `why` the ruling's id.
   */
  readonly ruled?: readonly { readonly at: string; readonly want: string; readonly why: string }[];
  /** Widths measured at, in both themes. Default 1480. */
  readonly widths?: readonly number[];
}

export interface LookScreen {
  readonly id: string;
  readonly probes: readonly LookProbe[];
}

/**
 * Rulings that moved one painted colour everywhere: where the mockup paints
 * `mockup` in `theme`, the build paints `want`. DR-10 folded the dark muted
 * ink to 55 percent; the mockup drew 46 (SIDEBAR.md DS-SIDE-2, 12).
 */
export const RULED_PAINT: readonly {
  readonly theme: 'light' | 'dark';
  readonly mockup: string;
  readonly want: string;
  readonly why: string;
}[] = [
  { theme: 'dark', mockup: 'rgba(248,248,248,117)', want: 'rgba(248,248,248,140)', why: 'DR-10' },
];
