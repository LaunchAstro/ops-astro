// SPDX-License-Identifier: AGPL-3.0-only
//
// The hook that mounts an `AuthorisedRead` on a component.
//
// It is separate from `authorised-read.ts` on purpose: the ordering and
// invalidation rules are the part with teeth and they are tested without React
// anywhere near them. This file is the wiring — a ref that keeps one projection
// across renders, and a re-read that hands its generation back.
//
// The projection is rebuilt when the grant key changes, because a projection
// belongs to a grant and a new reader may not inherit the old one's answers.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthorisedRead, initialState, type ReadState } from './authorised-read.ts';
import type { CallResult } from '../operations/client.ts';

export interface UseReadOptions<T> {
  readonly grantKey: string;
  /** Called with a generation; whatever it resolves to is offered back. */
  readonly run: () => Promise<CallResult<T>>;
  readonly isEmpty?: (value: T) => boolean;
  /** Re-read when any of these change. The grant key is always included. */
  readonly deps: readonly unknown[];
}

export interface UseReadResult<T> {
  readonly state: ReadState<T>;
  readonly reload: () => void;
}

export function useRead<T>(options: UseReadOptions<T>): UseReadResult<T> {
  const [state, setState] = useState<ReadState<T>>(() => initialState<T>(options.grantKey));
  const readRef = useRef<AuthorisedRead<T> | null>(null);
  const runRef = useRef(options.run);
  runRef.current = options.run;

  const grantKey = options.grantKey;
  const isEmpty = options.isEmpty;

  const reload = useCallback(() => {
    const projection = readRef.current;
    if (projection === null) return;
    const generation = projection.begin();
    void (async () => {
      projection.accept(generation, await runRef.current(), grantKey);
    })();
  }, [grantKey]);

  useEffect(() => {
    const projection = new AuthorisedRead<T>(
      isEmpty === undefined
        ? { grantKey, onState: setState }
        : { grantKey, onState: setState, isEmpty },
    );
    readRef.current = projection;
    setState(projection.state);
    const generation = projection.begin();
    void (async () => {
      projection.accept(generation, await runRef.current(), grantKey);
    })();
    return () => {
      // Nothing in flight can land on a projection nobody holds, and the next
      // mount gets its own generation counter starting from zero.
      readRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the dependency list is the caller's, plus the grant.
  }, [grantKey, ...options.deps]);

  return { state, reload };
}
