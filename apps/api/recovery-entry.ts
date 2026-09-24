// SPDX-License-Identifier: AGPL-3.0-only
//
// Restart recovery at process start. TRANSACTION-CONTRACT lines 84 and 92: a
// first-head restart resumes the bounded classifier against transitions that
// were recorded and not classified. `apps/api/server.ts` awaits this after its
// dependencies are validated and before it binds the port, so an API process
// start or restart is the resume entry. There is no database-only reconnect
// callback: a database that restarts under a running API is recovered on the
// API's next start.
//
// Three decisions worth seeing.
//
// **The scope is deployment configuration, never discovered.** The
// deployment names its businesses in `RECOVERY_BUSINESS_KEYS`, each key is
// resolved on its own through the server's one key-to-id lookup, and the ids
// are de-duplicated before any replay. Nothing here lists every business, and
// no request, seed or fixture supplies the set. `none` is the one way to say
// "no businesses", and it is a word rather than a blank so that a variable
// nobody set cannot read as a decision.
//
// **One transaction per business, through the application role.** Each replay
// runs inside `withBusiness`, which sets the tenant with local scope; the
// administrative connection resolves keys and touches no domain row. Tenants
// are recovered one after another, never in one transaction.
//
// **A failure stops the process.** The classifier throws when discovery
// changed under its locks, and that transaction rolls back. There is no
// retry: the next normal start runs recovery again in a fresh transaction,
// which is the bound. A committed business stays committed, and the classifier
// finds nothing left to do there next time.

import type { BusinessId, Database } from '../../packages/core-records/src/tenancy/database.ts';
import {
  replayRecordedTransitions,
  type Classification,
} from '../../packages/core-runtime/src/recovery.ts';

/** The setting's name, in the environment or `.local/recovery.env`. */
export const RECOVERY_SCOPE_SETTING = 'RECOVERY_BUSINESS_KEYS';

/** The literal that declares a deployment with no businesses to recover. */
export const NO_DEPLOYMENT_BUSINESSES = 'none';

/**
 * A key has no format of its own in `0001_tenancy.sql`, so this refuses only
 * what cannot be one entry of a comma-separated list: empty, or holding space.
 */
const KEY = /^\S{1,200}$/u;

export type RecoveryScope =
  | { readonly ok: true; readonly keys: readonly string[] }
  | { readonly ok: false; readonly problem: string };

/**
 * The configured value to a finite list of distinct keys. An empty list means
 * the value was `none`. Unset, blank, a malformed entry, an empty entry or
 * `none` beside a key is a problem, reported with the setting's name.
 */
export function parseRecoveryScope(raw: string | undefined): RecoveryScope {
  if (raw === undefined || raw.trim() === '') {
    return {
      ok: false,
      problem: `${RECOVERY_SCOPE_SETTING} is not set. Name the deployment's business keys, comma separated, or ${NO_DEPLOYMENT_BUSINESSES}.`,
    };
  }
  if (raw.trim() === NO_DEPLOYMENT_BUSINESSES) return { ok: true, keys: [] };

  const keys: string[] = [];
  for (const entry of raw.split(',')) {
    const key = entry.trim();
    if (key === NO_DEPLOYMENT_BUSINESSES) {
      return {
        ok: false,
        problem: `${RECOVERY_SCOPE_SETTING}: ${NO_DEPLOYMENT_BUSINESSES} cannot be combined with business keys.`,
      };
    }
    if (!KEY.test(key)) {
      return {
        ok: false,
        problem: `${RECOVERY_SCOPE_SETTING}: ${JSON.stringify(key)} is not a business key.`,
      };
    }
    if (!keys.includes(key)) keys.push(key);
  }
  return { ok: true, keys };
}

export interface RecoveredBusiness {
  readonly key: string;
  readonly businessId: BusinessId;
  readonly classified: readonly Classification[];
}

export type RecoveryOutcome =
  | { readonly ok: true; readonly businesses: readonly RecoveredBusiness[] }
  | { readonly ok: false; readonly problem: string };

/**
 * Resolve every key first, then replay each business in its own transaction.
 *
 * Resolution completes before the first replay, so an unknown key fails the
 * start with nothing written. Two keys that resolve to one business replay it
 * once.
 */
export async function recoverDeployment(
  database: Database,
  resolveBusiness: (businessKey: string) => Promise<string | undefined>,
  keys: readonly string[],
): Promise<RecoveryOutcome> {
  const targets: { key: string; businessId: BusinessId }[] = [];
  for (const key of keys) {
    // One key at a time, on the resolver's single connection.
    // eslint-disable-next-line no-await-in-loop
    const businessId = await resolveBusiness(key);
    if (businessId === undefined) {
      return {
        ok: false,
        problem: `${RECOVERY_SCOPE_SETTING}: business key ${JSON.stringify(key)} does not resolve to a business.`,
      };
    }
    if (!targets.some((target) => target.businessId === businessId)) {
      targets.push({ key, businessId });
    }
  }

  const businesses: RecoveredBusiness[] = [];
  for (const target of targets) {
    try {
      // Sequential by design: one tenant's transaction commits or rolls back
      // before the next one opens.
      // eslint-disable-next-line no-await-in-loop
      const classified = await database.withBusiness(
        target.businessId,
        async (tx) => await replayRecordedTransitions(tx),
      );
      businesses.push({ ...target, classified });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : 'unknown';
      return {
        ok: false,
        problem: `restart recovery for business ${JSON.stringify(target.key)} rolled back: ${reason}`,
      };
    }
  }
  return { ok: true, businesses };
}

/** One line per business, after its transaction committed. */
export function describeRecovered(business: RecoveredBusiness): string {
  const released = business.classified.filter((one) => one.released).length;
  const quarantined = business.classified.filter((one) => one.state === 'quarantined').length;
  return `restart recovery: ${business.key} committed, ${String(business.classified.length)} classified, ${String(released)} released, ${String(quarantined)} quarantined`;
}
