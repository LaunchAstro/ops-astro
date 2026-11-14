// SPDX-License-Identifier: AGPL-3.0-only
//
// One page's writes in flight, across its controls (#2359, Sol S2405-1).
//
// Each control's write runs through its own `useCommand`, so one control could
// not see another's: a Confirm delete could be pressed while the person's own
// assignment was still saving. Under a `PageWrites` provider, every
// `useCommand` reports while it is busy, and a control that must not start
// while anything else on the page is saving asks `usePageBusy`. Outside a
// provider nothing is reported and nothing is held.

import {
  createContext,
  createElement,
  use,
  useCallback,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

const Report = createContext<((delta: number) => void) | null>(null);
const Busy = createContext(false);

/** The page's writes: counted while any reporting control has one in flight. */
export function PageWrites(props: { readonly children: ReactNode }): ReactElement {
  const [inFlight, setInFlight] = useState(0);
  const report = useCallback((delta: number) => {
    setInFlight((count) => count + delta);
  }, []);
  // Plain calls, not JSX: `use-command.ts` reaches this file from the API's typecheck too.
  return createElement(
    Report,
    { value: report },
    createElement(Busy, { value: inFlight > 0 }, props.children),
  );
}

/** Count this control's write while `busy`, under the nearest `PageWrites`. */
export function useReportWrite(busy: boolean): void {
  const report = use(Report);
  useEffect(() => {
    if (!busy || report === null) return;
    report(1);
    return () => {
      report(-1);
    };
  }, [busy, report]);
}

/** Whether any write on this page is in flight now; false outside a provider. */
export function usePageBusy(): boolean {
  return use(Busy);
}
