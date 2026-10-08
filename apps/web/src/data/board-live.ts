// SPDX-License-Identifier: AGPL-3.0-only
// The board and dependent task/list reads follow BOARD on the tab's existing
// stream. Inbox-only changes refresh registered inbox panels alone.
import { useCallback, useEffect, useRef } from 'react';
import type { TaskReadResult } from '../../../../packages/core-wire/src/index.ts';
import type { ReadState } from './authorised-read.ts';
import type { OperationsClient } from '../operations/client.ts';
import { hubOf, type LiveChange } from './live.ts';

export const BOARD = 'board';
export type FollowInbox = (reload: () => void) => () => void;

function useBoardChanges(
  client: OperationsClient,
  grantKey: string,
  onChange: (change: LiveChange) => void,
  admitted: boolean,
): void {
  const current = useRef(onChange);
  current.current = onChange;
  useEffect(() => {
    if (!admitted) return;
    return hubOf(client).follow(BOARD, (change) => {
      current.current(change);
    });
  }, [client, grantKey, admitted]);
}

export type DependencyAdmission = 'admitted' | 'recovering' | 'withdrawn';

/** An outage is not a new authority answer; denial or a different owner is. */
export function dependencyAdmission<T>(state: ReadState<T>, own: boolean): DependencyAdmission {
  if (!own || state.outcome === 'denied') return 'withdrawn';
  if (state.outcome === 'loading' || state.outcome === 'unavailable') return 'recovering';
  return 'admitted';
}

/** The person read adds Client facts (even null); delegated detail omits them. */
export function taskDependencyAdmission(
  state: ReadState<TaskReadResult>,
  own: boolean,
): DependencyAdmission {
  const admission = dependencyAdmission(state, own);
  if (admission !== 'admitted') return admission;
  const value = state.outcome === 'loading' ? state.previous : state.value;
  return value !== null && 'task' in value && 'client' in value.task ? 'admitted' : 'withdrawn';
}

/** A frame requests another authorised read; it never carries task data. */
export function useTaskDependencies(
  client: OperationsClient,
  grantKey: string,
  refresh: () => void,
  admission: DependencyAdmission,
): void {
  const previous = useRef({ client, grantKey, admitted: false });
  const sameOwner = previous.current.client === client && previous.current.grantKey === grantKey;
  const admitted =
    admission === 'admitted' ||
    (admission === 'recovering' && sameOwner && previous.current.admitted);
  previous.current = { client, grantKey, admitted };
  useBoardChanges(
    client,
    grantKey,
    (change) => {
      if (change !== 'inbox') refresh();
    },
    admitted,
  );
}

export function useBoardLive(
  client: OperationsClient,
  grantKey: string,
  reloadBoard: () => void,
): FollowInbox {
  const panels = useRef(new Set<() => void>());
  useBoardChanges(
    client,
    grantKey,
    (change) => {
      if (change !== 'inbox') reloadBoard();
      for (const reload of panels.current) reload();
    },
    true,
  );
  return useCallback((reload) => {
    panels.current.add(reload);
    return () => {
      panels.current.delete(reload);
    };
  }, []);
}
