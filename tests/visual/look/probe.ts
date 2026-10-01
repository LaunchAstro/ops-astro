// SPDX-License-Identifier: AGPL-3.0-only
//
// What a look probe and a screen's probe list are. A leaf: each screen's file
// and `index.ts` import these from here, so no screen file imports the index
// that lists it (the cycle ui/b1-polish broke the same way at e10e25f).

export interface LookProbe {
  /** `<screen>.<element>`, unique across screens. */
  readonly id: string;
  /** The mockup page path and the element there; `open` clicks before measuring. */
  readonly mockup: { readonly path: string; readonly selector: string; readonly open?: string };
  /** The app page (drawn from the made-up reads) and the element there. */
  readonly app: { readonly page: string; readonly selector: string; readonly open?: string };
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
