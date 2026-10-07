// SPDX-License-Identifier: AGPL-3.0-only
//
// The provider steps an act owes, tried as soon as it commits, in transactions
// of their own after the act's, where the server holds the provider's admin key
// (the local server): C58's access endings and C59's factor resets (ORCH65-Q3).
// An ending's transaction holds the server's connection through its calls, and
// waits a bounded time for its login's lock (`ACCESS_ENDING_LOCK_WAIT_MS`).
// Whatever fails or waits too long stays owed for the endings loop. Moved from
// `app.ts` beside the reset.
//
// Both are tried only where the shared-login check is held, the same signal
// as the key: the Vercel function has neither, and leaves every step to the
// endings loop (ORCH47).

import {
  settleAccessEndings,
  settleFactorResets,
  type LoginProvider,
} from '../../packages/core-commands/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';

export interface AfterCommit {
  readonly database: Database;
  readonly logins?: LoginProvider;
  readonly sharedLogin?: (subject: string, businessId: string) => Promise<boolean>;
}

/**
 * Settle what the committed act `name` owes, and answer its result: a reset
 * whose provider step is done here says so (`providerStep: 'done'`).
 */
export async function settleAfterCommit<R extends object>(
  options: AfterCommit,
  businessId: BusinessId,
  name: string,
  result: R,
): Promise<R> {
  const { logins, sharedLogin } = options;
  if (logins === undefined || sharedLogin === undefined) return result;
  if (name === 'access.end') {
    const only = idsOf(result, 'endingIds');
    const sharedElsewhere = async (subject: string) => await sharedLogin(subject, businessId);
    if (only.length > 0) {
      await settleAccessEndings(options.database, businessId, logins, { only, sharedElsewhere });
    }
  }
  if (name === 'access.reset_factor') {
    const only = idsOf(result, 'resetId');
    if (only.length === 0) return result;
    const report = await settleFactorResets(options.database, businessId, logins, { only });
    if (report.settled === only.length) return withStep(result, 'done');
  }
  return result;
}

/** The ids an answer's detail names under `key` (C58, C59): ids, and nothing else. */
function idsOf(result: object, key: string): readonly string[] {
  const detail = (result as { readonly detail?: unknown }).detail;
  if (typeof detail !== 'object' || detail === null) return [];
  const ids = (detail as Readonly<Record<string, unknown>>)[key];
  const listed = Array.isArray(ids) ? ids : [ids];
  return listed.filter((id): id is string => typeof id === 'string');
}

function withStep<R extends object>(result: R, providerStep: 'done'): R {
  const detail = (result as { readonly detail?: Readonly<Record<string, unknown>> }).detail;
  return { ...result, detail: { ...detail, providerStep } };
}
