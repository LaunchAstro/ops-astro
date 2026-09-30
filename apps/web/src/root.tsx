// SPDX-License-Identifier: AGPL-3.0-only
//
// The address, as state, over the tab's real history.
//
// `pushState` plus a `popstate` listener rather than a router package: none is
// named in `docs/platform-construction.md`, the registry in `routes.ts` is what
// the application resolves through, and a hard reload of a task address has to
// land on that address (B5) — which is a server rewrite, not a router feature.
// The window is handed in, so a test drives this over jsdom's own history.

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { App, type AppProps } from './App.tsx';
import { TabHistory } from './tab-history.ts';

export interface RootProps extends Omit<AppProps, 'path' | 'navigate' | 'steps'> {
  readonly window: Window;
}

/** The whole address: a legacy one carries its client and tab in the query and hash. */
const addressOf = (at: Location): string => `${at.pathname}${at.search}${at.hash}`;

export function Root(props: RootProps): ReactElement {
  const { window: tab, ...app } = props;
  const history = useMemo(() => new TabHistory(tab), [tab]);
  const read = () => ({
    path: addressOf(tab.location),
    canBack: history.canBack,
    canForward: history.canForward,
  });
  const [at, setAt] = useState(read);
  useEffect(() => {
    const onPop = (event: PopStateEvent): void => {
      history.moved(event.state);
      setAt(read());
    };
    tab.addEventListener('popstate', onPop);
    return () => {
      tab.removeEventListener('popstate', onPop);
    };
    // `read` closes over the same two, which is all it reads.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, history]);
  const navigate = (next: string, options?: { readonly replace?: boolean }): void => {
    if (options?.replace === true) history.replace(next);
    else history.push(next);
    setAt(read());
  };
  return (
    <App
      {...app}
      path={at.path}
      navigate={navigate}
      steps={{
        canBack: at.canBack,
        canForward: at.canForward,
        onBack: () => {
          tab.history.back();
        },
        onForward: () => {
          tab.history.forward();
        },
      }}
    />
  );
}
