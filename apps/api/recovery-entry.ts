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

import type { BusinessId, Database, TenantQuery } from '../../packages/core-records/src/index.ts';
import { lookupEffect } from '../../packages/core-commands/src/index.ts';
import {
  EFFECT_OPERATIONS,
  reconcileUnknown,
  replayRecordedTransitions,
  sweepLostWorkers,
} from '../../packages/core-runtime/src/index.ts';
import type {
  Classification,
  EffectLookup,
  Reconciled,
} from '../../packages/core-runtime/src/index.ts';

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

export interface RecoveredBusiness<T = Classification> {
  readonly key: string;
  readonly businessId: BusinessId;
  readonly classified: readonly T[];
  /** What the reconciliation phase answered (T3d1), when the pass ran it. */
  readonly reconciled?: readonly Reconciled[];
}

export type RecoveryOutcome<T = Classification> =
  | { readonly ok: true; readonly businesses: readonly RecoveredBusiness<T>[] }
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
  return await eachBusiness(
    database,
    resolveBusiness,
    keys,
    'restart recovery',
    async (tx) => await replayRecordedTransitions(tx),
  );
}

/**
 * T3b: the sweep, the reconciliation pass's lease-expiry phase, over the same
 * configured businesses, each in its own transaction on the tenancy
 * connection, as system work. `server.ts` runs it on an interval once the port
 * is bound. A business that fails rolls back alone and is named; the next pass
 * sweeps it again, which is the bound.
 */
export async function sweepDeployment(
  database: Database,
  resolveBusiness: (businessKey: string) => Promise<string | undefined>,
  keys: readonly string[],
): Promise<RecoveryOutcome> {
  return await eachBusiness(
    database,
    resolveBusiness,
    keys,
    'sweep',
    // T3e1: the sweep with its drop step, so a lost worker's work comes back.
    async (tx) => await sweepLostWorkers(tx),
  );
}

async function eachBusiness<T>(
  database: Database,
  resolveBusiness: (businessKey: string) => Promise<string | undefined>,
  keys: readonly string[],
  pass: string,
  run: (tx: TenantQuery) => Promise<readonly T[]>,
): Promise<RecoveryOutcome<T>> {
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

  const businesses: RecoveredBusiness<T>[] = [];
  for (const target of targets) {
    try {
      // Sequential by design: one tenant's transaction commits or rolls back
      // before the next one opens.
      // eslint-disable-next-line no-await-in-loop
      const classified = await database.withBusiness(target.businessId, run);
      businesses.push({ ...target, classified });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : 'unknown';
      return {
        ok: false,
        problem: `${pass} for business ${JSON.stringify(target.key)} rolled back: ${reason}`,
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

/** How often the API sweeps, in milliseconds: a lease's shortest window is minutes, not seconds. */
export const SWEEP_INTERVAL_MS = 60_000;

/**
 * Run `pass` every `everyMs`, one pass at a time: a pass still running when
 * the next is due is skipped rather than stacked. A pass that fails is logged
 * with its problem and the next one runs anyway. `stop` ends the interval.
 */
export function startSweeper(
  pass: () => Promise<RecoveryOutcome>,
  everyMs: number = SWEEP_INTERVAL_MS,
): { readonly stop: () => void } {
  let running = false;
  const once = async (): Promise<void> => {
    try {
      const outcome = await pass();
      if (outcome.ok) for (const business of outcome.businesses) describeSwept(business);
      else console.error(`api: ${outcome.problem}`);
    } catch (cause) {
      console.error(`api: sweep failed: ${cause instanceof Error ? cause.message : 'unknown'}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void once();
  }, everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

/** One line per business the sweep changed, after its transaction committed. */
function describeSwept(business: RecoveredBusiness): void {
  const answered = business.reconciled ?? [];
  if (answered.length > 0) {
    const count = (answer: Reconciled['answer']) =>
      String(answered.filter((one) => one.answer === answer).length);
    console.log(
      `reconcile: ${business.key} committed, ${count('present')} settled on proof, ${count('absent')} proved absent, ${count('unanswered')} left for a person`,
    );
  }
  if (business.classified.length === 0) return;
  const released = business.classified.filter((one) => one.released).length;
  const unknown = business.classified.filter((one) => one.state === 'liability_unknown').length;
  console.log(
    `sweep: ${business.key} committed, ${String(released)} released, ${String(unknown)} held as unknown liabilities`,
  );
}

/**
 * T3d1: the operation register's answer for an unknown step. A step whose
 * effect replays by its token (the synthetic comment) is answered by the
 * register, under the holder's own identity; any other kind cannot be, and
 * waits for a person.
 *
 * The register holds the comment and nothing else. A registered comment
 * proves the effect happened. A missing one proves nothing about a provider
 * the worker reached and lost the answer from (a `provider_unavailable` or
 * `connection_lost` drop after the mark, T3e1): that provider may have acted,
 * so the register cannot answer, the whole hold stays, and a person records
 * what happened. The same holds for a worker lost
 * after it recorded its provider start (`provider_started_at`):
 * it reached a provider that may have acted. A lost worker with no start
 * recorded never reached one, and its missing comment is still an answer.
 */
export const registerEffectLookup: EffectLookup = async (tx, step) => {
  if (EFFECT_OPERATIONS[step.stepKind] !== 'replay') return;
  if ((await lookupEffect(tx, step.holderActorId, step.attemptId)) !== undefined) return true;
  const [attempt] = await tx.query<{
    readonly drop_cause: string | null;
    readonly provider_started: boolean;
  }>(
    `select drop_cause, provider_started_at is not null as provider_started
       from public.attempts where business_id = $1 and id = $2`,
    [tx.businessId, step.attemptId],
  );
  const providerReached =
    attempt?.provider_started === true ||
    attempt?.drop_cause === 'provider_unavailable' ||
    attempt?.drop_cause === 'connection_lost';
  return providerReached ? undefined : false;
};

/**
 * The one reconciliation pass, as the API runs it on its interval: the sweep,
 * then the recorded-transition replay (its production caller from T3d1 on,
 * beside start-time recovery), then the register's answers. Each phase is one
 * transaction per business on the tenancy connection, so no phase takes a
 * lock after another phase's in the same transaction.
 */
export async function passDeployment(
  database: Database,
  resolveBusiness: (businessKey: string) => Promise<string | undefined>,
  keys: readonly string[],
  lookup: EffectLookup,
): Promise<RecoveryOutcome> {
  const swept = await sweepDeployment(database, resolveBusiness, keys);
  if (!swept.ok) return swept;
  const replayed = await recoverDeployment(database, resolveBusiness, keys);
  if (!replayed.ok) return replayed;
  const answered = await eachBusiness(
    database,
    resolveBusiness,
    keys,
    'reconcile',
    async (tx) => await reconcileUnknown(tx, lookup),
  );
  if (!answered.ok) return answered;
  return {
    ok: true,
    businesses: swept.businesses.map((business, at) => ({
      key: business.key,
      businessId: business.businessId,
      classified: [...business.classified, ...(replayed.businesses[at]?.classified ?? [])],
      reconciled: answered.businesses[at]?.classified ?? [],
    })),
  };
}
