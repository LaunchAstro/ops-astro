// SPDX-License-Identifier: AGPL-3.0-only
//
// Quotas (API-3): requests in a window and calls at once, per credential, person and business,
// and list page sizes, from the one table `QUOTAS`; charged once per served request after login
// resolution admits it, checked and charged with no await between (docs/local/API.md, step 6).

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
  readonly limits: QuotaLimits;
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
    limits,
    take(holders) {
      const at = now();
      // A key unused for a whole window is dropped, so callers seen once do not accumulate.
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
  return over(
    ['concurrent', holder],
    `calls at once for this ${holder}. The limit is ${most} at a time; send again once one has answered.`,
  );
}

function overRequests(limits: QuotaLimits, holder: Holder, waitMs: number): QuotaRefusal {
  const most = String(limits.requests[holder]);
  const window = String(limits.requests.windowMs / 1000);
  const wait = String(Math.max(1, Math.ceil(waitMs / 1000)));
  return over(
    ['requests', holder],
    `requests for this ${holder}. The limit is ${most} in ${window} seconds; send again in ${wait} seconds.`,
  );
}

const over = (names: readonly string[], why: string): QuotaRefusal =>
  refuseCommand('QUOTA_EXCEEDED', names, [`Too many ${why}`]);

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
  /** A stream answered and still running: its end gives the slot back, not the answer. */
  held: boolean;
}

const scopes = new AsyncLocalStorage<Scope>();

/** One served request, charged at most once; its slot comes back when it ends, or its stream does. */
export async function withQuotaScope<T>(gate: QuotaGate, run: () => Promise<T>): Promise<T> {
  const scope: Scope = { gate, release: undefined, held: false };
  try {
    return await scopes.run(scope, run);
  } finally {
    if (!scope.held) scope.release?.();
  }
}

/** Keeps this request's slot past its answer, for a live stream; the stream calls the release. */
export function holdQuotaSlot(): () => void {
  const scope = scopes.getStore();
  if (scope === undefined) return nothingHeld;
  scope.held = true;
  return () => scope.release?.();
}

const nothingHeld = (): void => {};

/** A list read's page sizes: the table this request is served under, else `QUOTAS`'. */
export function pageSizes(): QuotaLimits['pageSize'] {
  return scopes.getStore()?.gate.limits.pageSize ?? QUOTAS.pageSize;
}

/** Charges an admitted call once per served request, or refuses and records `QUOTA_EXCEEDED`. */
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
