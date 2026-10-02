// SPDX-License-Identifier: AGPL-3.0-only
//
// Show or hide finished subtasks (MP-4-4, CS-4.27): the person's own key
// `subtasks.showFinished`, kept as `saved-flag.ts` keeps every such choice.
// Hidden is the default. The task page holds the value above its read.

import type { OperationsClient } from '../../operations/client.ts';
import { useSavedFlag, type SavedFlagHold } from './saved-flag.ts';

export const SHOW_FINISHED = 'subtasks.showFinished';

export function useShowFinished(
  client: OperationsClient,
  hold?: SavedFlagHold,
): readonly [boolean, (next: boolean) => void] {
  return useSavedFlag(client, SHOW_FINISHED, hold);
}
