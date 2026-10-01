// SPDX-License-Identifier: AGPL-3.0-only
//
// The app's own entry (apps/web/src/main.tsx) with one difference: the session
// may open every client. Client grants arrive with MP-10-1's records, and until
// then the real entry opens none, so the client face of the frame (MP-2-4,
// MP-2-6, MP-2-9) is drawn in a browser only through this entry. The harness
// swaps it in for a client address (tests/surfaces/mp-2-8-harness.test.tsx);
// the rest is the real Root and App, served by the app's own Vite config.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../packages/ui/src/index.ts';
import '../../apps/web/src/styles/6-slice.css';
import { Root } from '../../apps/web/src/root.tsx';
import { SessionStore, tabStorage } from '../../apps/web/src/session/token.ts';

const storage = tabStorage();
const host = document.querySelector('#app');
if (host !== null) {
  createRoot(host).render(
    <StrictMode>
      <Root
        window={window}
        sessions={new SessionStore(storage)}
        gotrueUrl="http://127.0.0.1:9/auth/v1"
        apiOrigin=""
        fetch={window.fetch.bind(window)}
        storage={storage}
        clientAccess={() => true}
      />
    </StrictMode>,
  );
}
