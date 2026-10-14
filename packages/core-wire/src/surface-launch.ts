// SPDX-License-Identifier: AGPL-3.0-only
//
// Launch from the task and the run's take, spread into `COMMAND_SURFACE` in
// `surface.ts` (kept apart for the line cap). A person who directs the task's
// agent opens a run for it (`tasks-launch.ts`), which no agent may do; the
// launched agent, signed in as itself and holding nothing, takes it
// (`tasks-take-launch.ts`), which no person may do.

import type { CommandDeclaration } from './surface-declaration.ts';
import { declare } from './surface-builders.ts';

export const LAUNCH_SURFACE: readonly CommandDeclaration[] = [
  declare('task.launch', 'assign'),
  declare('task.take_launch', 'write', {
    targetsExistingRecord: false,
    authorisedOn: 'claim',
    untargetedIdentifiers: ['launchId'],
    runtimeShaped: 'launchId',
    agent: 'before-pickup',
  }),
];
