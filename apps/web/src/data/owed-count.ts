// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-3 bell count at load: the dock's Notifications tab carries INB-1's
// owed figure with the first frame, read from `inbox.count` in the frame's own
// load, beside the person menu's name. The figure is the count's, never a
// tally of rows; a refused or failed count is no figure, never a zero. It
// follows the `board` topic on the tab's one stream (C4), as `/inbox/` does,
// so a new notification moves it without a reload.

import { useEffect, useState } from 'react';
import type { InboxCountResult } from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../operations/client.ts';
import type { Session } from '../session/token.ts';
import { BOARD } from './board-live.ts';
import { hubOf } from './live.ts';

/** The owed figure for this session, or null while unread, refused or failed. */
export function useOwedCount(
  client: OperationsClient,
  session: Session | null,
  shown: boolean,
): number | null {
  const [owed, setOwed] = useState<{ readonly of: Session; readonly owed: number } | null>(null);
  useEffect(() => {
    if (session === null || !shown) return;
    let current = true;
    const read = (): void => {
      void client.read<InboxCountResult>('inbox.count', {}).then((answer) => {
        if (current) setOwed('value' in answer ? { of: session, owed: answer.value.owed } : null);
        return answer;
      });
    };
    read();
    const stop = hubOf(client).follow(BOARD, read);
    return () => {
      current = false;
      stop();
    };
  }, [client, session, shown]);
  return owed !== null && owed.of === session ? owed.owed : null;
}
