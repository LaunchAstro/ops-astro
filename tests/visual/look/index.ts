// SPDX-License-Identifier: AGPL-3.0-only
//
// The look probes, one file per Stage 1 screen (UI-POLISH). Each probe names
// one element in the pinned mockup and the same element in the app, and the
// properties that must match; `look.ts --measure` pins the mockup's values in
// `<screen>.mockup.json` and `look.ts` holds the app to them. A screen's file
// is the one place its look is asserted, so two screens never share a list.

import { ACCESS } from './access.ts';
import { BOARD } from './board.ts';
import { SETTINGS } from './settings.ts';
import { SHELL } from './shell.ts';
import { SIGN_IN } from './sign-in.ts';
import { TASK } from './task.ts';
import { TELEMETRY } from './telemetry.ts';

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

export const LOOK_SCREENS: readonly LookScreen[] = [
  SHELL,
  BOARD,
  TASK,
  SETTINGS,
  SIGN_IN,
  ACCESS,
  TELEMETRY,
];
