// SPDX-License-Identifier: AGPL-3.0-only
//
// What Launch from the task and the run's take do to data, a block of
// `COMMAND_EFFECTS` (data-effects.ts), which spreads it in. A Launch writes
// its launch and mints its delegation; a take moves the launch, and one that
// finds it unable to run ends it and settles its delegation.

import type { LaunchCommandName } from './surface-launch-names.ts';
import { business, client, writing, type DataEffects } from './data-effects-types.ts';

const LAUNCH = writing([...client('task_launches'), ...business('delegations')]);

export const LAUNCH_EFFECTS: { readonly [Name in LaunchCommandName]: DataEffects } = {
  'task.launch': LAUNCH,
  'task.take_launch': LAUNCH,
};
