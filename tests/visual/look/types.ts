// SPDX-License-Identifier: AGPL-3.0-only
//
// The look probes' shapes. The screen files import them from here, not from
// index.ts, so the list that imports every screen is never imported back.

/**
 * Before measuring: `store` puts values in the page's localStorage before it
 * loads (a state the mockup replays before paint, such as its dragged rail
 * width), and `drag` moves an element's centre by `by` pixels along x with
 * the pointer, the way a person drags an edge.
 */
export interface LookPrep {
  readonly open?: string;
  readonly store?: Readonly<Record<string, string>>;
  readonly drag?: { readonly selector: string; readonly by: number };
}

export interface LookProbe {
  /** `<screen>.<element>`, unique across screens. */
  readonly id: string;
  /** The mockup page path and the element there; `open` clicks before measuring. */
  readonly mockup: LookPrep & { readonly path: string; readonly selector: string };
  /** The app page (drawn from the made-up reads) and the element there. */
  readonly app: LookPrep & { readonly page: string; readonly selector: string };
  /** Computed style properties (colours compared as painted), or `box.width|height|x|y`. */
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
