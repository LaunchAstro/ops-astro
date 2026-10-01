// SPDX-License-Identifier: AGPL-3.0-only
//
// What a look probe is (UI-POLISH). Its own module, so the screen files and
// the list in index.ts each import it and never each other.

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
