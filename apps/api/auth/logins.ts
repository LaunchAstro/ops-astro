// SPDX-License-Identifier: AGPL-3.0-only
//
// The sign-in provider's calls for a login whose access has ended (C58).

import type { LoginProvider } from '../../../packages/core-commands/src/index.ts';

export interface GoTrueLoginOptions {
  /** GoTrue's own URL, `GOTRUE_URL`. The only destination this adapter calls. */
  readonly baseUrl: string;
  /** A short-lived administrative bearer for the deactivation. */
  readonly adminToken: () => Promise<string>;
  /** A short-lived bearer naming the subject, for its global sign-out. */
  readonly subjectToken: (subject: string) => Promise<string>;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly fetch?: typeof fetch;
}

export function createGoTrueLogins(_options: GoTrueLoginOptions): LoginProvider {
  throw new Error('C58: createGoTrueLogins is not built yet');
}
