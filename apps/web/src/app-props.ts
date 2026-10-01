// SPDX-License-Identifier: AGPL-3.0-only
//
// What the application (`App.tsx`) is given by its entry. Moved whole from that
// file to keep it under the line limit.

import type { StripSteps } from '@launchastro/ui';
import type { DockAppProps } from './dock/dock-props.tsx';
import type { ClientAccess } from './manifest.ts';
import type { SessionStore } from './session/token.ts';

export interface AppProps extends DockAppProps {
  /** The address the application is drawing. Owned here, not read from a global. */
  readonly path: string;
  /** `replace` corrects the address of the page already open, adding no history entry. */
  readonly navigate: (path: string, options?: { readonly replace?: boolean }) => void;
  /** The tab's Back and Forward, when the entry owns a history (MP-2-5). */
  readonly steps?: StripSteps;
  readonly sessions: SessionStore;
  /** Where the identity provider is. Injected so a test never needs a network. */
  readonly gotrueUrl: string;
  /** The API's origin: empty behind the dev proxy, which serves `/api` on the page's own. */
  readonly apiOrigin: string;
  readonly fetch: typeof globalThis.fetch;
  /** This tab's storage, read once by the entry, or null where it is blocked. */
  readonly storage: Storage | null;
  /** Which clients the session may open. None until MP-10-1 supplies client records. */
  readonly clientAccess?: ClientAccess;
}
