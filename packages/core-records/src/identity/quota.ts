// SPDX-License-Identifier: AGPL-3.0-only
//
// Quotas (API-3), in one place: requests in a window and calls at
// once, each per credential, per person and per business, and the page size a
// list read may ask for. `QUOTAS` is the whole table; nothing else holds a
// number for any of them.
//
// **Counted after the door, never before it.** A call is charged only once
// login resolution has admitted it (`withSession`, and the agent envelope
// after `resolveAgentLogin`), so the business, the credential and the person
// are verified facts. Charging at the HTTP door would let a caller the
// business does not admit, holding any valid login, use up a business's
// quota: the door knows the business key and the bearer, not membership.
//
// **One charge per request.** A served request runs inside `withQuotaScope`,
// which the composition root installs on every request. The first admission
// in it takes the slot and the request's window entries; the envelope's one
// bounded retry and its failure record admit again inside the same scope and
// are not charged twice. Outside a served request (a worker, recovery, a test
// calling an executor directly) there is no scope and no quota: those are not
// callers of the API.
//
// **No await between the check and the charge.** `take` reads every counter
// and, only if all of them pass, charges all of them, in one synchronous run
// of the event loop. Two calls at once in one process cannot both pass on the
// same last slot. The counters are this process's: a deployment of several
// API processes gives each its own, which the served installation (one API
// process) does not have.
//
// A refused call is not charged, so a caller retrying into an exhausted
// window does not push it further out, and it is recorded where every other
// refusal at the door is: `authentication_attempts`, in the call's own
// transaction, with the code and no body.
//
// Export size and model cost are not here yet: no operation on the surface
// exports or spends model cost today. Each joins this table with the first
// operation that does.

import { AsyncLocalStorage } from 'node:async_hooks';
import { refuseCommand, type CommandRefusal } from '../register.ts';
import type { TenantQuery } from '../tenancy/database.ts';
import { recordAuthenticationAttempt, type AttemptOwner } from './authentication-attempts.ts';
import type { VerifiedSubject } from './verified-subject.ts';

type Holder = 'credential' | 'person' | 'business';
const HOLDERS: readonly Holder[] = ['credential', 'person', 'business'];

export interface QuotaLimits {
  /** Requests admitted per holder in any window of `windowMs`. */
  readonly requests: { readonly windowMs: number } & Readonly<Record<Holder, number>>;
  /** Calls admitted and not yet finished, per holder. */
  readonly concurrent: Readonly<Record<Holder, number>>;
  /** A list read's page: its size when none is asked for, and the most one may ask for. */
  readonly pageSize: { readonly standard: number; readonly most: number };
}

export const QUOTAS: QuotaLimits = {
  requests: { windowMs: 60_000, credential: 1_200, person: 1_200, business: 12_000 },
  concurrent: { credential: 16, person: 16, business: 128 },
  pageSize: { standard: 20, most: 100 },
};

export interface QuotaOptions {
  readonly limits?: QuotaLimits;
  /** Milliseconds; the wall clock unless a test moves its own. */
  readonly now?: () => number;
}

/** Who a call is charged to, all three verified by login resolution. */
export interface QuotaHolders {
  readonly business: string;
  /** The login the call presented. */
  readonly credential: string;
  /** The person, or for an agent's call the agent actor it acts as. */
  readonly person: string;
}

export type QuotaRefusal = CommandRefusal<'QUOTA_EXCEEDED'>;

type Taken =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly refusal: QuotaRefusal };

export interface QuotaGate {
  take(holders: QuotaHolders): Taken;
}

export function createQuotaGate(options: QuotaOptions = {}): QuotaGate {
  const limits = options.limits ?? QUOTAS;
  const now = options.now ?? Date.now;
  const windows = new Map<string, number[]>();
  const inFlight = new Map<string, number>();

  /** The key's admissions still inside the window, oldest first. */
  function recent(key: string, at: number): number[] {
    const log = windows.get(key) ?? [];
    while (log.length > 0 && (log[0] as number) <= at - limits.requests.windowMs) log.shift();
    if (log.length === 0) windows.delete(key);
    return log;
  }

  function refusal(holder: Holder, at: number, key: string): QuotaRefusal | undefined {
    if ((inFlight.get(key) ?? 0) >= limits.concurrent[holder])
      return overConcurrent(limits, holder);
    const log = recent(key, at);
    if (log.length < limits.requests[holder]) return undefined;
    return overRequests(limits, holder, (log[0] as number) + limits.requests.windowMs - at);
  }

  return {
    take(holders) {
      const at = now();
      // A key nobody has called with for a whole window holds nothing: dropped
      // here, so callers seen once do not accumulate.
      if (windows.size > SWEEP_AT) for (const key of windows.keys()) recent(key, at);
      const keys = HOLDERS.map((holder) => [holder, keyOf(holder, holders)] as const);
      for (const [holder, key] of keys) {
        const refused = refusal(holder, at, key);
        if (refused !== undefined) return { ok: false, refusal: refused };
      }
      for (const [, key] of keys) {
        const log = recent(key, at);
        log.push(at);
        windows.set(key, log);
        inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
      }
      return {
        ok: true,
        release: releaser(
          inFlight,
          keys.map(([, key]) => key),
        ),
      };
    },
  };
}

const SWEEP_AT = 10_000;

function overConcurrent(limits: QuotaLimits, holder: Holder): QuotaRefusal {
  const most = String(limits.concurrent[holder]);
  return refuseCommand(
    'QUOTA_EXCEEDED',
    ['concurrent', holder],
    [
      `Too many calls at once for this ${holder}. The limit is ${most} at a time; send again once one has answered.`,
    ],
  );
}

function overRequests(limits: QuotaLimits, holder: Holder, waitMs: number): QuotaRefusal {
  const most = String(limits.requests[holder]);
  const window = String(limits.requests.windowMs / 1000);
  const wait = String(Math.max(1, Math.ceil(waitMs / 1000)));
  return refuseCommand(
    'QUOTA_EXCEEDED',
    ['requests', holder],
    [
      `Too many requests for this ${holder}. The limit is ${most} in ${window} seconds; send again in ${wait} seconds.`,
    ],
  );
}

/** Gives the call's slots back, once, however often it is called. */
function releaser(inFlight: Map<string, number>, keys: readonly string[]): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) {
      const left = (inFlight.get(key) ?? 1) - 1;
      if (left > 0) inFlight.set(key, left);
      else inFlight.delete(key);
    }
  };
}

/** A holder's key, scoped by business so two businesses never share a counter. */
function keyOf(holder: Holder, holders: QuotaHolders): string {
  if (holder === 'business') return `business/${holders.business}`;
  return `${holder}/${holders.business}/${holders[holder]}`;
}

interface Scope {
  readonly gate: QuotaGate;
  release: (() => void) | undefined;
}

const scopes = new AsyncLocalStorage<Scope>();

/**
 * One served request, charged at most once. Its slot is given back when the
 * request ends, however it ends: answered, refused or faulted.
 */
export async function withQuotaScope<T>(gate: QuotaGate, run: () => Promise<T>): Promise<T> {
  const scope: Scope = { gate, release: undefined };
  try {
    return await scopes.run(scope, run);
  } finally {
    scope.release?.();
  }
}

/**
 * Charge the call now that login resolution has admitted it, or refuse it
 * `QUOTA_EXCEEDED` and record the refusal in the caller's transaction.
 * Nothing outside a served request, and nothing a second time within one.
 */
export async function admitQuota(
  tx: TenantQuery,
  owner: AttemptOwner,
  presented: VerifiedSubject,
  holders: Omit<QuotaHolders, 'business'>,
): Promise<QuotaRefusal | undefined> {
  const scope = scopes.getStore();
  if (scope === undefined || scope.release !== undefined) return undefined;
  const taken = scope.gate.take({ ...holders, business: tx.businessId });
  if (taken.ok) {
    scope.release = taken.release;
    return undefined;
  }
  await recordAuthenticationAttempt(tx, {
    owner,
    presented,
    outcome: 'refused',
    refusalCode: 'QUOTA_EXCEEDED',
  });
  return taken.refusal;
}

/**
 * `admitQuota` for an agent's login, charged once admitted as on the person
 * path: to the agent's login, and to the agent actor it acts as.
 */
export async function admitAgentQuota(
  tx: TenantQuery,
  presented: VerifiedSubject,
  session: { readonly loginId: string; readonly actorId: string },
): Promise<QuotaRefusal | undefined> {
  const holders = { credential: session.loginId, person: session.actorId };
  return await admitQuota(tx, 'agent_login', presented, holders);
}
