// SPDX-License-Identifier: AGPL-3.0-only
//
// C58's endings loop, one pass and its settings (ORCH46 ruling B, ORCH47).
// It runs on the environment's machine, beside the forwarder, and is the only
// hosted process that holds the provider's admin key. The owner's login reads
// across businesses (business ids with an owed ending, and whether a login is
// live elsewhere) and nothing else; each business's endings are read, settled
// and stamped on the application login, inside that business's tenancy.

import {
  isBusinessId,
  loginLiveElsewhere,
  type AdminConnection,
  type Database,
} from '../../packages/core-records/src/index.ts';
import { settleAccessEndings, type LoginProvider } from '../../packages/core-commands/src/index.ts';
import { providerAdminKey } from '../api/auth/provider-logins.ts';

/** How often the loop retries the provider steps an access ending owes. */
export const ACCESS_ENDING_RETRY_SECONDS = 60;

const REQUIRED = [
  'DATABASE_URL',
  'DATABASE_ADMIN_URL',
  'GOTRUE_URL',
  'SUPABASE_SERVICE_KEY',
] as const;

/**
 * The loop's settings, checked before anything connects: each one present,
 * and a key the issuer may be sent (https, or loopback). A problem names the
 * setting, never a value.
 */
export function endingsSettings(
  environment: Readonly<Record<string, string | undefined>>,
):
  | { readonly ok: true; readonly adminKey: () => Promise<string> }
  | { readonly ok: false; readonly problem: string } {
  const missing = REQUIRED.filter((name) => (environment[name] ?? '') === '');
  if (missing.length > 0) return { ok: false, problem: `set ${missing.join(', ')}` };
  // No local key directory: the loop is hosted, and a hosted key is the service key.
  const adminKey = providerAdminKey(environment, '/nonexistent');
  if (adminKey === undefined) {
    return { ok: false, problem: 'GOTRUE_URL must be https (or loopback) to carry the key' };
  }
  return { ok: true, adminKey };
}

/**
 * One retry pass (C58), the endings loop's: every business with an access ending that still owes
 * the provider a step, each settled under its own tenancy. The owner's
 * connection reads business ids and nothing else; the endings themselves are
 * read and stamped on the application connection, inside the business.
 * Answers how many endings still owe a step.
 */
export async function retryAccessEndings(
  admin: AdminConnection,
  database: Database,
  logins: LoginProvider,
  /** A test's shorter claim; the settle's own otherwise. */
  claimSeconds?: number,
): Promise<number> {
  const rows = await admin.execute<{ readonly business_id: string }>(
    `select distinct business_id from public.access_endings
      where sessions_ended_at is null or login_deactivated_at is null`,
  );
  let owed = 0;
  for (const row of rows) {
    if (!isBusinessId(row.business_id)) continue;
    const business = row.business_id;
    const settle = settleAccessEndings(database, business, logins, {
      sharedElsewhere: async (subject) => await loginLiveElsewhere(admin, subject, business),
      ...(claimSeconds === undefined ? {} : { claimSeconds }),
    });
    // eslint-disable-next-line no-await-in-loop -- one business at a time, each under its own tenancy
    owed += (await settle).owed;
  }
  return owed;
}
