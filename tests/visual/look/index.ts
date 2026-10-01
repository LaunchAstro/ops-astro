// SPDX-License-Identifier: AGPL-3.0-only
//
// The look probes, one file per Stage 1 screen (UI-POLISH). Each probe names
// one element in the pinned mockup and the same element in the app, and the
// properties that must match; `look.ts --measure` pins the mockup's values in
// `<screen>.mockup.json` and `look.ts` holds the app to them. A screen's file
// is the one place its look is asserted, so two screens never share a list.

import { ACCESS } from './access.ts';
import { BOARD } from './board.ts';
import { CLIENTS } from './clients.ts';
import { DOCK } from './dock.ts';
import { FRAME } from './frame.ts';
import { GALLERY_LOOK } from './gallery.ts';
import { INBOX } from './inbox.ts';
import { SETTINGS } from './settings.ts';
import { SHELL } from './shell.ts';
import { RAIL } from './rail.ts';
import { SIGN_IN } from './sign-in.ts';
import { STATES_SCREEN } from './states.ts';
import { TASK } from './task.ts';
import { TASK_PANEL } from './task-panel.ts';
import { TEAM } from './team.ts';
import { TELEMETRY } from './telemetry.ts';
import { TODOS } from './todos.ts';
import { WORKLOG } from './worklog.ts';
import type { LookScreen } from './probe.ts';

export { RULED_PAINT, type LookPrep, type LookProbe, type LookScreen } from './probe.ts';

export const LOOK_SCREENS: readonly LookScreen[] = [
  SHELL,
  RAIL,
  BOARD,
  TASK,
  SETTINGS,
  SIGN_IN,
  GALLERY_LOOK,
  STATES_SCREEN,
  ACCESS,
  TELEMETRY,
  CLIENTS,
  DOCK,
  TODOS,
  TASK_PANEL,
  INBOX,
  TEAM,
  WORKLOG,
  FRAME,
];
