// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1f: the board screen follows the `board` topic on the tab's one stream
// (C4), beside every other page's topics. The board, the inbox list and its
// owed count share it, so a tab never holds a stream per panel. An
// `invalidate` or a resync re-reads the board and the inbox; an `inbox` signal
// re-reads the inbox alone. While the stream is down the hub's 30-second floor
// re-reads both; while it is up, nothing polls.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { OperationsClient } from '../operations/client.ts';
import { hubOf } from './live.ts';
import { useRead, type UseReadOptions } from './use-read.ts';
import { tabRollupFloor } from './rollup-floor.ts';

/** The board's topic on the tab's one stream (C4). */
export const BOARD = 'board';

/** Register a re-read of an inbox panel; the returned function stops it. */
export type FollowInbox = (reload: () => void) => () => void;

/** Follow the tab's stream: the board re-reads through `reloadBoard`, each inbox panel through what it registers. */
export function useBoardLive(
  client: OperationsClient,
  grantKey: string,
  reloadBoard?: () => void,
): FollowInbox {
  const boardRef = useRef(reloadBoard);
  boardRef.current = reloadBoard;
  const panels = useRef(new Set<() => void>());
  useEffect(
    () =>
      hubOf(client).follow(BOARD, (change) => {
        if (change !== 'inbox') boardRef.current?.();
        for (const reload of panels.current) reload();
      }),
    [client, grantKey],
  );
  return useCallback((reload) => {
    panels.current.add(reload);
    return () => {
      panels.current.delete(reload);
    };
  }, []);
}

/** A dependent projection follows the existing board channel and its fallback. */
export function useBoardDependency(
  client: OperationsClient,
  grantKey: string,
  reload: () => void,
): void {
  useBoardLive(client, grantKey, reload);
}

/** Row and vocabulary dependencies retain their floor, coalesced with board changes. */
export function useBoardProjectionRead<T>(client: OperationsClient, options: UseReadOptions<T>) {
  const source = useMemo(() => {
    let pending: (() => void) | null = null;
    const schedule = (run: () => void, board: boolean): void => {
      if (pending !== null) {
        if (board) pending = run;
        return;
      }
      pending = run;
      queueMicrotask(() => {
        const next = pending;
        pending = null;
        next?.();
      });
    };
    return {
      floor: {
        follow: (run: () => void) =>
          tabRollupFloor().follow(() => {
            schedule(run, false);
          }),
      },
      board: (run: () => void) => {
        schedule(run, true);
      },
      stop: () => {
        pending = null;
      },
    };
  }, [client, options.grantKey]);
  const read = useRead({ ...options, rollup: source.floor });
  useEffect(() => {
    const stop = hubOf(client).follow(BOARD, (change) => {
      if (change !== 'inbox') source.board(read.reload);
    });
    return () => {
      stop();
      source.stop();
    };
  }, [client, source, read.reload]);
  return read;
}
