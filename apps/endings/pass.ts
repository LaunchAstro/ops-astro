// SPDX-License-Identifier: AGPL-3.0-only
//
// C58's endings loop, one pass and its settings (ORCH46 ruling B, ORCH47),
// and C59's factor resets beside the endings (ORCH65-Q3).
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
import {
  settleAccessEndings,
  settleFactorResets,
  type LoginProvider,
} from '../../packages/core-commands/src/index.ts';
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
 * each database setting a connection string postgres.js reads as written, and
 * a key the issuer may be sent (https, or loopback). A problem names the
 * setting, never a value.
 */
export function endingsSettings(
  environment: Readonly<Record<string, string | undefined>>,
):
  | { readonly ok: true; readonly adminKey: () => Promise<string> }
  | { readonly ok: false; readonly problem: string } {
  const missing = REQUIRED.filter((name) => (environment[name] ?? '') === '');
  if (missing.length > 0) return { ok: false, problem: `set ${missing.join(', ')}` };
  for (const name of ['DATABASE_URL', 'DATABASE_ADMIN_URL'] as const) {
    if (!readAsWritten(environment[name] as string)) {
      return { ok: false, problem: `${name} is not a postgres connection string with one host` };
    }
  }
  // No local key directory: the loop is hosted, and a hosted key is the service key.
  const adminKey = providerAdminKey(environment, '/nonexistent');
  if (adminKey === undefined) {
    return { ok: false, problem: 'GOTRUE_URL must be https (or loopback) to carry the key' };
  }
  return { ok: true, adminKey };
}

/**
 * Whether postgres.js reads `raw` as the URL parser does: its host (the text
 * after the first `@`, decoded) is the URL's, with no comma anywhere before
 * it. Otherwise part of a password could be taken for a host.
 */
function readAsWritten(raw: string): boolean {
  let url: URL;
  let host: string;
  const authority = raw.slice(raw.indexOf('://') + 3).split(/[?/]/u)[0] ?? '';
  try {
    url = new URL(raw);
    host = decodeURIComponent(authority.slice(authority.indexOf('@') + 1));
  } catch {
    return false;
  }
  const scheme = url.protocol === 'postgres:' || url.protocol === 'postgresql:';
  return scheme && host === url.host && !host.includes(',') && !authority.includes(',');
}

/** A pass's backlog, everything still owed, and how many rows it left owed on a fault. */
export interface PassCount {
  readonly owed: number;
  readonly faults: number;
}

/**
 * One retry pass (C58), the endings loop's: every business with an access ending that still owes
 * the provider a step, each settled under its own tenancy. The owner's
 * connection reads business ids and nothing else; the endings themselves are
 * read and stamped on the application connection, inside the business.
 * Answers how many endings still owe a step, one another retry holds included.
 */
export async function retryAccessEndings(
  admin: AdminConnection,
  database: Database,
  logins: LoginProvider,
  /** A test's shorter claim; the settle's own otherwise. */
  claimSeconds?: number,
): Promise<number> {
  return (await accessEndingsPass(admin, database, logins, claimSeconds)).owed;
}

async function accessEndingsPass(
  admin: AdminConnection,
  database: Database,
  logins: LoginProvider,
  claimSeconds?: number,
): Promise<PassCount> {
  const rows = await admin.execute<{ readonly business_id: string }>(
    `select distinct business_id from public.access_endings
      where sessions_ended_at is null or login_deactivated_at is null`,
  );
  let owed = 0;
  let faults = 0;
  for (const row of rows) {
    if (!isBusinessId(row.business_id)) continue;
    const business = row.business_id;
    const settle = settleAccessEndings(database, business, logins, {
      sharedElsewhere: async (subject) => await loginLiveElsewhere(admin, subject, business),
      ...(claimSeconds === undefined ? {} : { claimSeconds }),
    });
    // eslint-disable-next-line no-await-in-loop -- one business at a time, each under its own tenancy
    const report = await settle;
    owed += report.owed;
    faults += report.faults;
  }
  return { owed, faults };
}

/**
 * One retry pass over C59's factor resets (ORCH65-Q3), as over the endings:
 * the owner's connection reads the business ids with a reset owed and
 * nothing else; each business's resets are claimed, sent and stamped on the
 * application connection, inside the business. Answers how many still owe,
 * one another settle holds included, and how many it asked ended on a fault.
 */
export async function retryFactorResets(
  admin: AdminConnection,
  database: Database,
  logins: LoginProvider,
  claimSeconds?: number,
): Promise<PassCount> {
  const rows = await admin.execute<{ readonly business_id: string }>(
    'select distinct business_id from public.factor_resets where done_at is null',
  );
  let owed = 0;
  let faults = 0;
  for (const row of rows) {
    if (!isBusinessId(row.business_id)) continue;
    const options = claimSeconds === undefined ? {} : { claimSeconds };
    // eslint-disable-next-line no-await-in-loop -- one business at a time, each under its own tenancy
    const report = await settleFactorResets(database, row.business_id, logins, options);
    owed += report.owed;
    faults += report.faults;
  }
  return { owed, faults };
}

/**
 * The endings loop's pass: the access endings, then the factor resets. A
 * fault on any step it asked, or an ending's login lock not taken in time,
 * fails the pass (`--once` exits 1).
 */
export async function retryOwedSteps(
  admin: AdminConnection,
  database: Database,
  logins: LoginProvider,
  claimSeconds?: number,
): Promise<PassCount> {
  const endings = await accessEndingsPass(admin, database, logins, claimSeconds);
  const resets = await retryFactorResets(admin, database, logins, claimSeconds);
  return { owed: endings.owed + resets.owed, faults: endings.faults + resets.faults };
}
