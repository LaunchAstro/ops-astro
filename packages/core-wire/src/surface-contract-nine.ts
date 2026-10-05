// SPDX-License-Identifier: AGPL-3.0-only
//
// The contract's nine. Split from `surface.ts`, which re-exports the name, to
// keep that file under the line limit.

import type { CommandName } from './command-names.ts';

/** The contract's nine, the first nine names of `CommandName`. */
export const CONTRACT_NINE: readonly CommandName[] = [
  'task.create',
  'task.update',
  'task.complete',
  'task.reopen',
  'task.comment',
  'task.propose',
  'task.decide',
  'task.pickup',
  'task.handback',
];
