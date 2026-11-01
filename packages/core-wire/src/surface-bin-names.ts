// SPDX-License-Identifier: AGPL-3.0-only
//
// The bin's command names (specification 14.3, #2345, #2351), part of `CommandName`
// (`command-names.ts`). In a file that imports nothing, as `surface-review-names.ts` is.

/** An agent asks to delete a task, and a person confirms the delete or keeps the task (#2351). */
export type DeleteRequestCommandName =
  'task.request_delete' | 'task.confirm_delete' | 'task.decline_delete';

/** The bin: trash, a person's delete, its request, restore and purge. */
export type BinCommandName =
  'task.trash' | 'task.delete' | 'task.restore' | 'task.purge' | DeleteRequestCommandName;
