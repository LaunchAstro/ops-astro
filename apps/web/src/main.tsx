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

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@launchastro/ui';
import './styles/6-slice.css';
import { Root } from './root.tsx';
import { SessionStore, tabStorage } from './session/token.ts';

const GOTRUE_URL =
  (import.meta.env['VITE_GOTRUE_URL'] as string | undefined) ?? 'http://127.0.0.1:54391';
const API_ORIGIN = (import.meta.env['VITE_API_ORIGIN'] as string | undefined) ?? '';

// Read once, through the one guarded accessor: blocked site data makes the
// `sessionStorage` global throw on access, not only on use.
const storage = tabStorage();
const sessions = new SessionStore(storage);

const host = document.querySelector('#app');
if (host !== null) {
  createRoot(host).render(
    <StrictMode>
      <Root
        window={window}
        sessions={sessions}
        gotrueUrl={GOTRUE_URL}
        apiOrigin={API_ORIGIN}
        fetch={window.fetch.bind(window)}
        storage={storage}
      />
    </StrictMode>,
  );
}
