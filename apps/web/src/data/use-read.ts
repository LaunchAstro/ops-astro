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
import type { LiveHub } from './live.ts';
import type { RollupFloor } from './rollup-floor.ts';
import type { CallResult } from '../operations/client.ts';

export interface UseReadOptions<T> {
  readonly grantKey: string;
  /** Called with a generation; whatever it resolves to is offered back. */
  readonly run: () => Promise<CallResult<T>>;
  readonly isEmpty?: (value: T) => boolean;
  /** Re-read when any of these change. The grant key is always included. */
  readonly deps: readonly unknown[];
  /**
   * The live topic for what this read shows (C4), named from its last answer
   * and followed on the tab's one stream. Every change is read at once, an
   * unsaved edit included: the edit lives above the read and is never read
   * over, and the rest of the page keeps updating (C4 live-sync 4).
   */
  readonly live?: { readonly hub: LiveHub; readonly topic: (value: T) => string | undefined };
  /** An agency-wide rollup no topic reaches: re-read on the floor instead (C4 CS-1.2). */
  readonly rollup?: RollupFloor;
}

export interface UseReadResult<T> {
  readonly state: ReadState<T>;
  readonly reload: () => void;
}

/**
 * Run the read and offer its answer. An answer the projection cannot take
 * (its emptiness test throws) shows as unavailable instead of escaping.
 */
async function offer<T>(
  projection: AuthorisedRead<T>,
  generation: number,
  run: () => Promise<CallResult<T>>,
  grantKey: string,
): Promise<void> {
  const result = await run();
  try {
    projection.accept(generation, result, grantKey);
  } catch {
    const because = 'The API answered with something this screen could not read.';
    projection.accept(generation, { unavailable: true, because }, grantKey);
  }
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
    void offer(projection, generation, runRef.current, grantKey);
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
    void offer(projection, generation, runRef.current, grantKey);
    return () => {
      // Retire it, do not merely forget it. Clearing the reference stops the
      // next `reload` from finding it and stops nothing else: the read this
      // effect already started still holds the projection, and the projection
      // still holds `setState`. A grant change that denies the new read while
      // the old read is still in flight would then end with the old grant's
      // rows drawn as `ready` over the denial.
      projection.dispose();
      readRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the dependency list is the caller's, plus the grant.
  }, [grantKey, ...options.deps]);

  // The last answer's topic, kept while a re-read is in flight or denied, so a
  // revoked page still hears the channel that tells it so.
  const topicRef = useRef<string | null>(null);
  if (state.outcome === 'ready' || state.outcome === 'empty') {
    topicRef.current = options.live?.topic(state.value) ?? null;
  }
  const topic = topicRef.current;
  const hub = options.live?.hub;

  useEffect(() => {
    if (hub === undefined || topic === null) return;
    return hub.follow(topic, reload);
  }, [hub, topic, reload]);

  const { rollup } = options;
  useEffect(() => rollup?.follow(reload), [rollup, reload]);

  return { state, reload };
}
