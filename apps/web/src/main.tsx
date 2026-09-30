// SPDX-License-Identifier: AGPL-3.0-only
//
// The browser entry, and where the stylesheets' order is fixed.
//
// THE LOAD ORDER IS THE CONTRACT: the shared package's sheets first (tokens,
// primitives, shell, board, task surfaces, in the order its `index.ts` imports
// them), then this application's own. The package is imported here, before the
// slice's sheet and before any screen, so its sheets load first whichever
// module imports it next. Component modules import no CSS at all.
//
// It is also the composition root: the real `fetch`, the real `sessionStorage`
// and the addresses of the API and the identity provider are supplied here and
// nowhere else, so every module below can be driven by a test without one.
// Neither address is baked into the build (G3), so one build serves staging and
// production: the API is this page's own origin, and the identity provider's
// address is read from it before the first render.

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@launchastro/ui';
import './styles/6-slice.css';
import { App } from './App.tsx';
import { withProviderKey } from './session/provider-key.ts';
import { SessionStore, tabStorage } from './session/token.ts';

/**
 * The address, as state.
 *
 * `pushState` plus a `popstate` listener rather than a router package: none is
 * named in `docs/platform-construction.md`, the registry in `routes.ts` is what
 * the application resolves through, and a hard reload of a task address has to
 * land on that address (B5) — which is a server rewrite, not a router feature.
 */
function Root({
  gotrueUrl,
  fetcher,
}: {
  readonly gotrueUrl: string;
  readonly fetcher: typeof fetch;
}): React.ReactElement {
  const [path, setPath] = useState(addressOf(window.location));
  useEffect(() => {
    const onPop = (): void => {
      setPath(addressOf(window.location));
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
    };
  }, []);
  const navigate = (next: string): void => {
    window.history.pushState(null, '', next);
    setPath(next);
  };
  return (
    <App
      path={path}
      navigate={navigate}
      sessions={sessions}
      gotrueUrl={gotrueUrl}
      apiOrigin=""
      fetch={fetcher}
      storage={storage}
    />
  );
}

/** The whole address: a legacy one carries its client and tab in the query and hash. */
const addressOf = (at: Location): string => `${at.pathname}${at.search}${at.hash}`;

/** The identity provider's address and publishable key, as the API that checks sign-ins names them. */
async function signInAddress(): Promise<{ issuer: string; key: string | undefined }> {
  const answer = await window.fetch('/api/sign-in');
  const body = (await answer.json()) as { issuer?: unknown; key?: unknown };
  if (!answer.ok || typeof body.issuer !== 'string') throw new Error('no sign-in address');
  return { issuer: body.issuer, key: typeof body.key === 'string' ? body.key : undefined };
}

// Read once, through the one guarded accessor: blocked site data makes the
// `sessionStorage` global throw on access, not only on use.
const storage = tabStorage();
const sessions = new SessionStore(storage);

const host = document.getElementById('app');
if (host !== null) {
  const root = createRoot(host);
  try {
    const { issuer, key } = await signInAddress();
    const fetcher = withProviderKey(window.fetch.bind(window), issuer, key);
    root.render(
      <StrictMode>
        <Root gotrueUrl={issuer} fetcher={fetcher} />
      </StrictMode>,
    );
  } catch {
    root.render(<p>Ops Astro cannot reach its server. Reload the page to try again.</p>);
  }
}
