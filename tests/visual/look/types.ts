// SPDX-License-Identifier: AGPL-3.0-only
//
// The look probe's shape, apart from the list, so a screen's file and the
// list that gathers them import no cycle.

export interface LookProbe {
  /** `<screen>.<element>`, unique across screens. */
  readonly id: string;
  /** The mockup page path and the element there; `open` clicks, in turn, before measuring. */
  readonly mockup: {
    readonly path: string;
    readonly selector: string;
    readonly open?: string | readonly string[];
  };
  /** The app page (drawn from the made-up reads) and the element there. */
  readonly app: {
    readonly page: string;
    readonly selector: string;
    readonly open?: string | readonly string[];
  };
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
