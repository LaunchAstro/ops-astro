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
// Nor may it see them for one render: until the new projection publishes, the
// hook answers a first read's loading state, never the old grant's state.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthorisedRead, initialState, type ReadState } from './authorised-read.ts';
import { FLOOR_MS, type LiveHub } from './live.ts';
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

/** The states a projection starts from: a first read, not a re-read of one. */
const opening = new WeakSet<ReadState<unknown>>();

/** Whether `state` opens a read (a grant's or a record's first), so nothing earlier describes it. */
export const opensRead = (state: ReadState<unknown>): boolean => opening.has(state);

function opened<T>(grantKey: string): ReadState<T> {
  const state = initialState<T>(grantKey);
  opening.add(state);
  return state;
}

/**
 * Run the read and offer its answer. An answer the read or the projection
 * cannot take (a malformed body the read rejects on, an emptiness test that
 * throws) shows as unavailable instead of escaping.
 */
async function offer<T>(
  projection: AuthorisedRead<T>,
  generation: number,
  run: () => Promise<CallResult<T>>,
  grantKey: string,
): Promise<void> {
  try {
    projection.accept(generation, await run(), grantKey);
  } catch {
    const because = 'The API answered with something this screen could not read.';
    projection.accept(generation, { unavailable: true, because }, grantKey);
  }
}

/**
 * Re-read a live read that has no topic yet, its first answer unavailable: on
 * coming online, on being shown, and every 30 s while not hidden (C4). The
 * hub can only follow a topic, and the topic comes from an answer.
 */
function untilAnswered(reload: () => void): () => void {
  const retry = (): void => {
    if (document.visibilityState !== 'hidden') reload();
  };
  const floor = setInterval(retry, FLOOR_MS);
  window.addEventListener('online', retry);
  document.addEventListener('visibilitychange', retry);
  return () => {
    clearInterval(floor);
    window.removeEventListener('online', retry);
    document.removeEventListener('visibilitychange', retry);
  };
}

export function useRead<T>(options: UseReadOptions<T>): UseReadResult<T> {
  const [held, setState] = useState<ReadState<T>>(() => opened<T>(options.grantKey));
  const readRef = useRef<AuthorisedRead<T> | null>(null);
  const runRef = useRef(options.run);
  runRef.current = options.run;

  const grantKey = options.grantKey;
  const isEmpty = options.isEmpty;
  const first = useMemo(() => opened<T>(grantKey), [grantKey]);
  const state = held.grantKey === grantKey ? held : first;

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
    opening.add(projection.state);
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

  const unanswered = hub !== undefined && topic === null && state.outcome === 'unavailable';
  useEffect(() => {
    if (unanswered) return untilAnswered(reload);
    if (hub === undefined || topic === null) return;
    return hub.follow(topic, reload);
  }, [hub, topic, reload, unanswered]);

  const { rollup } = options;
  useEffect(() => rollup?.follow(reload), [rollup, reload]);

  return { state, reload };
}
