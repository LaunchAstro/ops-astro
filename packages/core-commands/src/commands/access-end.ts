// SPDX-License-Identifier: AGPL-3.0-only
//
// C58 (CS-2.25): end a person's access in one act, the tracked action
// `access ended (person: login, sessions, grants)` under `access:manage`,
// never an agent's.

import type { BusinessId, Database } from '../../../core-records/src/index.ts';
import type { ProviderAnswer } from './account-factor-provider.ts';

/**
 * The sign-in provider's two calls for a login whose access has ended: end
 * every session it has (which revokes their refresh tokens), and deactivate
 * the login so it cannot sign in again. Each is keyed by the provider's own
 * subject and is safe to ask twice.
 */
export interface LoginProvider {
  endSessions(subject: string): Promise<ProviderAnswer<void>>;
  deactivate(subject: string): Promise<ProviderAnswer<void>>;
}

/** What one pass over a business's owed endings did, by count only. */
export interface SettleReport {
  readonly attempted: number;
  readonly settled: number;
  readonly owed: number;
}

export function settleAccessEndings(
  _database: Database,
  _businessId: BusinessId,
  _provider: LoginProvider,
  _options: { readonly claimSeconds?: number } = {},
): Promise<SettleReport> {
  return Promise.reject(new Error('C58: settleAccessEndings is not built yet'));
}
