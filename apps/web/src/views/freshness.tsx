// SPDX-License-Identifier: AGPL-3.0-only
//
// C4's header marker (CS-1.1, SH-22): how fresh the open page is, drawn by the
// kit's `FreshnessMarker` in the header's meta slot. It is an indicator only;
// there is no sync button (LIVE-SYNC.md). A page tells the header through
// `useFreshOnPage`, from its own read and the tab's stream, and `freshnessOf`
// decides the state. A refused page claims nothing, a page not yet read claims
// nothing, and a closed page takes its marker with it.

import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import { FreshnessMarker, freshnessOf, type Freshness } from '@launchastro/ui';
import type { ReadState } from '../data/authorised-read.ts';
import type { LiveHub } from '../data/live.ts';

/** How often the marker's words age ("2 min ago") and its grace runs out. */
const TICK_MS = 15_000;

const Shown = createContext<Freshness | null>(null);
const Show = createContext<((freshness: Freshness | null) => void) | null>(null);

export function PageFreshnessProvider(props: { readonly children: ReactNode }): ReactElement {
  const [shown, show] = useReducer(
    (current: Freshness | null, next: Freshness | null) =>
      JSON.stringify(current) === JSON.stringify(next) ? current : next,
    null,
  );
  return (
    <Show.Provider value={show}>
      <Shown.Provider value={shown}>{props.children}</Shown.Provider>
    </Show.Provider>
  );
}

export function StripFreshness(): ReactElement | null {
  const shown = useContext(Shown);
  return shown === null ? null : <FreshnessMarker freshness={shown} />;
}

const online = {
  subscribe: (onChange: () => void) => {
    window.addEventListener('online', onChange);
    window.addEventListener('offline', onChange);
    return () => {
      window.removeEventListener('online', onChange);
      window.removeEventListener('offline', onChange);
    };
  },
  now: () => navigator.onLine,
};

interface ReadTimes {
  readonly state: ReadState<unknown> | null;
  readonly lastReadAt: number | null;
  readonly failingSince: number | null;
}

/** Each new read state moves the times once: a success, a failure, or a refusal. */
function timesAfter(times: ReadTimes, state: ReadState<unknown>, now: number): ReadTimes {
  if (times.state?.grantKey !== state.grantKey)
    times = { state: null, lastReadAt: null, failingSince: null };
  switch (state.outcome) {
    case 'ready':
    case 'empty':
      return { state, lastReadAt: now, failingSince: null };
    case 'unavailable':
      return { ...times, state, failingSince: times.failingSince ?? now };
    // The old read's time is about data a refused reader no longer sees.
    case 'denied':
      return { state, lastReadAt: null, failingSince: null };
    case 'loading':
      return { ...times, state };
  }
}

/** Put this page's freshness in the header while the page is open. */
export function useFreshOnPage(state: ReadState<unknown>, hub: LiveHub): void {
  const times = useRef<ReadTimes>({ state: null, lastReadAt: null, failingSince: null });
  if (times.current.state !== state) times.current = timesAfter(times.current, state, Date.now());
  const isOnline = useSyncExternalStore(online.subscribe, online.now);
  const streamDownSince = useSyncExternalStore(
    (onChange) => hub.watch(onChange),
    () => hub.downSince,
  );
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const { lastReadAt, failingSince } = times.current;
  const freshness = freshnessOf(
    {
      denied: state.outcome === 'denied',
      frozenAt: null,
      online: isOnline,
      streamDownSince,
      failingSince,
      lastReadAt,
      changedAt: null,
      source: null,
    },
    Date.now(),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );

  const show = useContext(Show);
  useEffect(() => {
    show?.(freshness);
  });
  useEffect(() => () => show?.(null), [show]);
}
