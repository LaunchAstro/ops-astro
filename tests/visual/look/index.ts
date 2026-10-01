// SPDX-License-Identifier: AGPL-3.0-only
//
// The look probes, one file per Stage 1 screen (UI-POLISH). Each probe names
// one element in the pinned mockup and the same element in the app, and the
// properties that must match; `look.ts --measure` pins the mockup's values in
// `<screen>.mockup.json` and `look.ts` holds the app to them. A screen's file
// is the one place its look is asserted, so two screens never share a list.

import { BOARD } from './board.ts';
import { CLIENTS } from './clients.ts';
import { DOCK } from './dock.ts';
import { SETTINGS } from './settings.ts';
import { SHELL } from './shell.ts';
import { RAIL } from './rail.ts';
import { SIGN_IN } from './sign-in.ts';
import { TASK } from './task.ts';

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

export const LOOK_SCREENS: readonly LookScreen[] = [
  SHELL,
  RAIL,
  BOARD,
  TASK,
  SETTINGS,
  SIGN_IN,
  CLIENTS,
  DOCK,
];
