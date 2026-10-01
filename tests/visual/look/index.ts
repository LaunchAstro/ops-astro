// SPDX-License-Identifier: AGPL-3.0-only
//
// The look probes, one file per Stage 1 screen (UI-POLISH). Each probe names
// one element in the pinned mockup and the same element in the app, and the
// properties that must match; `look.ts --measure` pins the mockup's values in
// `<screen>.mockup.json` and `look.ts` holds the app to them. A screen's file
// is the one place its look is asserted, so two screens never share a list.

import { BOARD } from './board.ts';
import { SETTINGS } from './settings.ts';
import { SHELL } from './shell.ts';
import { SIGN_IN } from './sign-in.ts';
import { STATES_SCREEN } from './states.ts';
import { TASK } from './task.ts';
import type { LookScreen } from './probe.ts';

export { RULED_PAINT, type LookProbe, type LookScreen } from './probe.ts';

export const LOOK_SCREENS: readonly LookScreen[] = [
  SHELL,
  BOARD,
  TASK,
  SETTINGS,
  SIGN_IN,
  STATES_SCREEN,
];
