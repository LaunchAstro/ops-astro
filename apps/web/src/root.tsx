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
import { App } from './App.tsx';
import type { AppProps } from './app-props.ts';
import { dropSignInLink } from './session/sign-in-link.ts';
import { TabHistory } from './tab-history.ts';

export interface RootProps extends Omit<AppProps, 'path' | 'navigate' | 'steps'> {
  readonly window: Window;
}

/** The whole address: a legacy one carries its client and tab in the query and hash. */
const addressOf = (at: Location): string => `${at.pathname}${at.search}${at.hash}`;

/**
 * The tab's own moves within the loaded page: Back, Forward and a followed fragment link. Each
 * clears a sign-in service's link first (`sign-in-link.ts`), then the address is read again.
 * A fragment-only move may come as `hashchange` alone, so both are heard.
 */
function useTabMoves(tab: Window, history: TabHistory, moved: () => void): void {
  useEffect(() => {
    const onPop = (event: PopStateEvent): void => {
      dropSignInLink(tab);
      history.moved(event.state);
      moved();
    };
    const onHash = (): void => {
      dropSignInLink(tab);
      moved();
    };
    tab.addEventListener('popstate', onPop);
    tab.addEventListener('hashchange', onHash);
    return () => {
      tab.removeEventListener('popstate', onPop);
      tab.removeEventListener('hashchange', onHash);
    };
    // `moved` reads the same two, which is all it reads.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, history]);
}

export function Root(props: RootProps): ReactElement {
  const { window: tab, ...app } = props;
  // A sign-in service's link is cleared before the address is first read (`sign-in-link.ts`),
  // and again whenever the address moves within the page, the application's own moves too.
  const history = useMemo(() => {
    dropSignInLink(tab);
    return new TabHistory(tab);
  }, [tab]);
  const read = () => ({
    path: addressOf(tab.location),
    canBack: history.canBack,
    canForward: history.canForward,
  });
  const [at, setAt] = useState(read);
  useTabMoves(tab, history, () => setAt(read()));
  const navigate = (next: string, options?: { readonly replace?: boolean }): void => {
    if (options?.replace === true) history.replace(next);
    else history.push(next);
    // A pushed or replaced address fires neither `popstate` nor `hashchange`: cleared here.
    dropSignInLink(tab);
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
