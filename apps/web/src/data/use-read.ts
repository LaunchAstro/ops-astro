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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AuthorisedRead, initialState, type ReadState } from './authorised-read.ts';
import { dropsAnswer } from './read-breaks.ts';
import { FLOOR_MS, type LiveRead } from './live.ts';
import type { RollupFloor } from './rollup-floor.ts';
import { isRefusal, isUnavailable, type CallResult } from '../operations/client.ts';
import { useFollow } from './use-follow.ts';

/**
 * What a run answers when it gave up because the tab was hidden: nothing
 * lands and nothing fails, and the floor's next tick, on being shown, reads again.
 */
export const RETIRED = Symbol('retired');

export interface UseReadOptions<T> {
  readonly grantKey: string;
  /** Called with a generation; whatever it resolves to is offered back. */
  readonly run: () => Promise<CallResult<T> | typeof RETIRED>;
  readonly isEmpty?: (value: T) => boolean;
  /** Re-read when any of these change. The grant key is always included. */
  readonly deps: readonly unknown[];
  /**
   * The live topic for what this read shows (C4), named from its last answer
   * and followed on the tab's one stream. Every change is read at once, an
   * unsaved edit included: the edit lives above the read and is never read
   * over, and the rest of the page keeps updating (C4 live-sync 4).
   */
  readonly live?: LiveRead<T>;
  /** An agency-wide rollup no topic reaches: re-read on the floor instead (C4 CS-1.2). */
  readonly rollup?: RollupFloor;
  /** Which published answers break what the host admits; refused or out when absent. */
  readonly breaks?: (state: ReadState<T>) => boolean;
  /**
   * One read at a time: a reload, the rollup floor's included, that finds a
   * read in flight starts one more when it ends, and never supersedes it. For
   * a run that bounds its own time, so a read slower than the floor still lands.
   */
  readonly coalesce?: boolean;
}

export interface UseReadResult<T> {
  readonly state: ReadState<T>;
  readonly reload: () => void;
}

/** `useRead`'s answer, and whether the read in flight came from the live channel. */
export interface UseReadLive<T> extends UseReadResult<T> {
  /** Re-read a live dependency while the host keeps its current editor mounted. */
  readonly refresh: () => void;
  /**
   * Offer an answer the screen read itself as the newest generation: the read
   * in flight is retired, and a refusal raises the floor as one of its own would.
   */
  readonly land: (result: CallResult<T>) => void;
  /** The read now, ahead of the render that draws it, and how many refusals or outages it has had. */
  readonly now: () => { readonly state: ReadState<T> | null; readonly failures: number };
  /**
   * True while the read in flight was started by the live channel, so a host
   * can keep its last answer drawn through an ordinary live change (MP-6-3).
   * A reload, a new grant or a changed dependency is not one.
   */
  readonly live: boolean;
  /**
   * Whether `state` answers this render's grant and dependencies. A changed
   * dependency renders once with the old read's state before the read resets;
   * a host that must not draw from it treats it as still loading.
   */
  readonly own: boolean;
  /** Breaks (`breaks`, and refusals of superseded reads) counted as each lands, drawn or not. */
  readonly breaks: number;
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
  run: () => Promise<CallResult<T> | typeof RETIRED>,
  grantKey: string,
  late: (result: CallResult<T>) => void,
): Promise<void> {
  try {
    const result = await run();
    if (result === RETIRED) return;
    if (!projection.accept(generation, result, grantKey)) late(result);
  } catch {
    const because = 'The API answered with something this screen could not read.';
    projection.accept(generation, { unavailable: true, because }, grantKey);
  }
}

export function useRead<T>(options: UseReadOptions<T>): UseReadLive<T> {
  const [held, setState] = useState<ReadState<T>>(() => opened<T>(options.grantKey));
  const [breaks, setBreaks] = useState(0);
  const breaksRef = useRef(options.breaks ?? dropsAnswer);
  breaksRef.current = options.breaks ?? dropsAnswer;
  const readRef = useRef<AuthorisedRead<T> | null>(null);
  const runRef = useRef(options.run);
  // The run as last committed: a render that never commits must not be what a re-read runs.
  useLayoutEffect(() => {
    runRef.current = options.run;
  });
  const grantKey = options.grantKey;
  const isEmpty = options.isEmpty;
  const first = useMemo(() => opened<T>(grantKey), [grantKey]);
  const state = held.grantKey === grantKey ? held : first;

  const liveRef = useRef(false);
  /** When the rollup floor first found the read in flight waiting; cleared by every re-read. */
  const waitedFrom = useRef<number | null>(null);
  /** The grant and dependencies the projection in `readRef` was built for. */
  const built = useRef<readonly unknown[]>([]);
  /** The read in flight, until it ends, and its generation; and the generation `land` retired. */
  const flight = useRef<Promise<void> | null>(null);
  const started = useRef(0);
  const displaced = useRef<number | null>(null);
  const start = useCallback(
    (projection: AuthorisedRead<T>) => {
      const generation = projection.begin();
      // A read `land` retired still withdraws on a refusal or outage: what landed read less.
      const late = (result: CallResult<T>): void => {
        if (readRef.current !== projection) return;
        if (displaced.current === generation && (isRefusal(result) || isUnavailable(result)))
          projection.accept(projection.begin(), result, grantKey);
        else if (isRefusal(result)) setBreaks((count) => count + 1);
      };
      const running = offer(projection, generation, runRef.current, grantKey, late);
      flight.current = running;
      started.current = generation;
      void running.finally(() => {
        if (flight.current === running) flight.current = null;
      });
    },
    [grantKey],
  );
  const reread = useCallback(
    (live: boolean) => {
      const projection = readRef.current;
      if (projection === null) return;
      liveRef.current = live;
      waitedFrom.current = null;
      start(projection);
    },
    [start],
  );
  const coalesce = options.coalesce === true;
  const reload = useCallback(() => {
    const running = flight.current;
    const projection = readRef.current;
    if (!coalesce || running === null) {
      reread(false);
      return;
    }
    // Once it ends, unless another read has begun or the projection is another reader's.
    void running.finally(() => {
      if (flight.current === null && readRef.current === projection) reread(false);
    });
  }, [reread, coalesce]);
  const refresh = useCallback(() => {
    reread(true);
  }, [reread]);
  const land = useCallback(
    (result: CallResult<T>) => {
      const projection = readRef.current;
      if (projection === null) return;
      liveRef.current = false;
      waitedFrom.current = null;
      displaced.current = flight.current === null ? null : started.current;
      projection.accept(projection.begin(), result, grantKey);
    },
    [grantKey],
  );
  const failures = useRef(0);
  const now = useCallback(
    () => ({ state: readRef.current?.state ?? null, failures: failures.current }),
    [],
  );

  useEffect(() => {
    const onState = (next: ReadState<T>): void => {
      if (next.outcome === 'denied' || next.outcome === 'unavailable') failures.current += 1;
      setState(next);
      if (breaksRef.current(next)) setBreaks((count) => count + 1);
    };
    const projection = new AuthorisedRead<T>(
      isEmpty === undefined ? { grantKey, onState } : { grantKey, onState, isEmpty },
    );
    readRef.current = projection;
    built.current = [grantKey, ...options.deps];
    liveRef.current = false;
    waitedFrom.current = null;
    displaced.current = null;
    opening.add(projection.state);
    setState(projection.state);
    start(projection);
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

  // The last answer belongs to its grant as well as its record: a business or
  // person change is a new reader, whose first answer the old topic must not
  // hold back from recovery (#397).
  useFollow(options.live, state, reread, [grantKey, ...options.deps]);

  useRollup(options.rollup, coalesce ? null : readRef, waitedFrom, reload);

  // A changed grant or dependency renders once before the effect above resets
  // the read, still holding the old read's state: that read is not live here.
  const own = same(built.current, [grantKey, ...options.deps]);
  return {
    state,
    reload,
    refresh,
    land,
    now,
    own,
    live: own && liveRef.current && state.outcome === 'loading',
    breaks,
  };
}

/**
 * How long a read in flight is waited for before a floor tick asks again:
 * three floors, less half of one, so a tick that runs a little early still
 * counts as the fourth.
 */
const ROLLUP_PATIENCE_MS = 3 * FLOOR_MS - FLOOR_MS / 2;

/**
 * Re-read on the rollup floor (C4 CS-1.2). A tick waits for the read in flight
 * rather than superseding it: a newer read would retire its answer, so reads
 * slower than the floor would never land. Reads have no transport timeout, so
 * a read still in flight `ROLLUP_PATIENCE_MS` after a tick first found it is
 * superseded, and a revoke still draws. The wait is time on the monotonic
 * clock, so tab-shows do not shorten it, and every re-read (`waitedFrom` is
 * cleared by `reread`) starts it again. With no projection to wait on (a
 * coalescing read, whose reload does its own waiting) every tick reloads.
 */
function useRollup<T>(
  rollup: RollupFloor | undefined,
  readRef: { readonly current: AuthorisedRead<T> | null } | null,
  waitedFrom: { current: number | null },
  reload: () => void,
): void {
  useEffect(
    () =>
      rollup?.follow(() => {
        if (readRef?.current?.state.outcome === 'loading') {
          const now = performance.now();
          waitedFrom.current ??= now;
          if (now - waitedFrom.current < ROLLUP_PATIENCE_MS) return;
        }
        reload();
      }),
    [rollup, readRef, waitedFrom, reload],
  );
}

/** Whether two dependency lists match, compared the way React compares them. */
function same(built: readonly unknown[], deps: readonly unknown[]): boolean {
  return built.length === deps.length && deps.every((each, at) => Object.is(each, built[at]));
}
