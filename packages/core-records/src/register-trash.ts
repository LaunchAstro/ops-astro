// SPDX-License-Identifier: AGPL-3.0-only
//
// The refusal register's bin rows (specification 14.3, #2345), split out of
// `register.ts` to keep it under the product file limit. `register.ts`
// spreads them last.

export const TRASH_ROWS = [
  {
    code: 'PARENT_TRASHED',
    status: 409,
    meaning: 'The parent is still in the trash, in the batch named',
    source: 'spec 14.3',
  },
  {
    code: 'ALREADY_TRASHED',
    status: 409,
    meaning: 'The subtree root is already in the trash',
    source: 'T1e, unregistered',
  },
  // `task.delete` is the bin under `decide`; work with history is cancelled instead.
  {
    code: 'TASK_NOT_DELETABLE',
    status: 409,
    meaning: 'The task or a subtask has money, run or client history, so it is cancelled instead',
    source: '#2345',
  },
] as const;
