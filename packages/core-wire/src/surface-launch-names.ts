// SPDX-License-Identifier: AGPL-3.0-only
//
// The launch commands' names, part of `CommandName` (`command-names.ts`). In a
// file that imports nothing, as `surface-setup.ts` is, so the name list does not
// reach back into the declarations that use it.

/** Launch from the task: a person opens a run, and its agent takes it. */
export type LaunchCommandName = 'task.launch' | 'task.take_launch';
