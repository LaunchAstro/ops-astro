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

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@launchastro/ui';
import './styles/6-slice.css';
import { Root } from './root.tsx';
import { SessionStore, tabStorage } from './session/token.ts';

/** The identity provider's address, as the API that checks sign-ins names it. */
async function signInAddress(): Promise<string> {
  const answer = await window.fetch('/api/sign-in');
  const body = (await answer.json()) as { issuer?: unknown };
  if (!answer.ok || typeof body.issuer !== 'string') throw new Error('no sign-in address');
  return body.issuer;
}

// Read once, through the one guarded accessor: blocked site data makes the
// `sessionStorage` global throw on access, not only on use.
const storage = tabStorage();
const sessions = new SessionStore(storage);

const host = document.querySelector('#app');
if (host !== null) {
  const root = createRoot(host);
  try {
    const gotrueUrl = await signInAddress();
    root.render(
      <StrictMode>
        <Root
          window={window}
          sessions={sessions}
          gotrueUrl={gotrueUrl}
          apiOrigin=""
          fetch={window.fetch.bind(window)}
          storage={storage}
        />
      </StrictMode>,
    );
  } catch {
    root.render(<p>Ops Astro cannot reach its server. Reload the page to try again.</p>);
  }
}
