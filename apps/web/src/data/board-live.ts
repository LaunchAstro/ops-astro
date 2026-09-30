// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1f: the board screen's one stream for the tab, `<person prefix><business>/live`.
// The board, the inbox list and its owed count share it, so a tab never holds
// a stream per panel. An `invalidate` or a resync re-reads the board and the
// inbox; an `inbox` signal re-reads the inbox alone. While the stream is down
// the 30-second floor re-reads both (`followLive`); while it is up, nothing polls.

import { useCallback, useEffect, useRef } from 'react';
import type { OperationsClient } from '../operations/client.ts';
import { followLive } from './live.ts';

/** Register a re-read of an inbox panel; the returned function stops it. */
export type FollowInbox = (reload: () => void) => () => void;

/** Follow the tab's stream: the board re-reads through `reloadBoard`, each inbox panel through what it registers. */
export function useBoardLive(
  client: OperationsClient,
  grantKey: string,
  reloadBoard: () => void,
): FollowInbox {
  const boardRef = useRef(reloadBoard);
  boardRef.current = reloadBoard;
  const panels = useRef(new Set<() => void>());
  useEffect(
    () =>
      followLive(
        async (signal) => await client.openBoardLive(signal),
        (change) => {
          if (change !== 'inbox') boardRef.current();
          for (const reload of panels.current) reload();
        },
      ),
    [client, grantKey],
  );
  return useCallback((reload) => {
    panels.current.add(reload);
    return () => {
      panels.current.delete(reload);
    };
  }, []);
}
