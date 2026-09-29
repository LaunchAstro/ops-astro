// SPDX-License-Identifier: AGPL-3.0-only
//
// The security detections (ticket S0-2, TR-SEC-9): repeated failed sign-ins,
// a permission, grant or custody change, a failed secret scan, a burst of
// cross-scope refusals, repeated webhook signature failures and unusual
// export or download volume.
//
// Each signal is counted under its own scope: the business and the person for
// sign-ins and refusals, the business and the source for webhooks, the
// business and the client for exports. One business's refusals never bring
// another's alert closer, and one client's exports never add to another's.
// The scope is a key in memory and nothing else: the alert raised is only its
// kind, so it cannot name the business, client or person that tripped it.
// The detector holds no connection and reads no row.

import type { AlertKind } from './catalogue.ts';

export type SecuritySignal =
  | { readonly kind: 'sign-in-failed'; readonly business: string; readonly person: string }
  | { readonly kind: 'authority-changed'; readonly business: string }
  | { readonly kind: 'secret-scan-failed' }
  | { readonly kind: 'cross-scope-refusal'; readonly business: string; readonly person: string }
  | {
      readonly kind: 'webhook-signature-failed';
      readonly business: string;
      readonly source: string;
    }
  | {
      readonly kind: 'export';
      readonly business: string;
      readonly client: string;
      readonly items: number;
    };

/** One API answer, as `apps/api/app.ts` reads it off the request. */
export interface Outcome {
  /** The business key from the path; the person is the verified subject, or empty. */
  readonly business: string;
  readonly person: string;
  /** The refusal code, or undefined when the command was carried out. */
  readonly refusal: string | undefined;
  readonly command: string;
}

const SIGN_IN_FAILED = new Set(['AUTH_UNKNOWN_LOGIN', 'ACTOR_INACTIVE']);
const CROSS_SCOPE = new Set(['AUTH_NO_MEMBERSHIP', 'SCOPE_NOT_GRANTED']);
const AUTHORITY = new Set(['grant.revoke', 'delegation.revoke']);

/** What an answer tells the detector, if anything. */
export function signalOf({
  business,
  person,
  refusal,
  command,
}: Outcome): SecuritySignal | undefined {
  if (refusal === undefined) {
    return AUTHORITY.has(command) ? { kind: 'authority-changed', business } : undefined;
  }
  if (SIGN_IN_FAILED.has(refusal)) return { kind: 'sign-in-failed', business, person };
  if (CROSS_SCOPE.has(refusal)) return { kind: 'cross-scope-refusal', business, person };
  return undefined;
}

interface Rule {
  readonly alert: AlertKind;
  /** Events, or exported items, within the window that raise the alert. */
  readonly threshold: number;
  readonly windowMs: number;
}

const MINUTE = 60_000;
const RULES: Readonly<Record<SecuritySignal['kind'], Rule>> = {
  'sign-in-failed': { alert: 'sign-in-failures', threshold: 5, windowMs: 15 * MINUTE },
  'authority-changed': { alert: 'authority-changed', threshold: 1, windowMs: MINUTE },
  'secret-scan-failed': { alert: 'secret-scan-failed', threshold: 1, windowMs: MINUTE },
  'cross-scope-refusal': { alert: 'cross-scope-burst', threshold: 10, windowMs: 10 * MINUTE },
  'webhook-signature-failed': {
    alert: 'webhook-signature-failures',
    threshold: 5,
    windowMs: 15 * MINUTE,
  },
  export: { alert: 'export-volume', threshold: 200, windowMs: 60 * MINUTE },
};

/** Past this many scopes in memory, the expired ones are swept. */
const SWEEP_AT = 10_000;

export interface Detector {
  readonly observe: (signal: SecuritySignal) => void;
  /** How many scopes are held: bounded, whatever a caller sends. */
  readonly tracked: () => number;
}

/** A scope as a JSON array: no business key or subject can spell another scope. */
function scopeOf(signal: SecuritySignal): string {
  switch (signal.kind) {
    case 'sign-in-failed':
    case 'cross-scope-refusal':
      return JSON.stringify([signal.business, signal.person]);
    case 'webhook-signature-failed':
      return JSON.stringify([signal.business, signal.source]);
    case 'export':
      return JSON.stringify([signal.business, signal.client]);
    case 'authority-changed':
      return signal.business;
    case 'secret-scan-failed':
      return '';
  }
}

export function createDetector(
  raise: (kind: AlertKind) => void,
  options: { readonly now?: () => number } = {},
): Detector {
  const now = options.now ?? Date.now;
  const seen = new Map<string, { at: number; weight: number }[]>();

  function sweep(at: number): void {
    for (const [key, events] of seen) {
      const rule = RULES[key.slice(0, key.indexOf('\u0001')) as SecuritySignal['kind']];
      if (events.every((event) => at - event.at >= rule.windowMs)) seen.delete(key);
    }
    // A flood of live scopes: the oldest are dropped, so memory stays bounded.
    for (const key of seen.keys()) {
      if (seen.size <= SWEEP_AT) break;
      seen.delete(key);
    }
  }

  function observe(signal: SecuritySignal): void {
    const rule = RULES[signal.kind];
    const at = now();
    const key = `${signal.kind}\u0001${scopeOf(signal)}`;
    const events = (seen.get(key) ?? []).filter((event) => at - event.at < rule.windowMs);
    events.push({ at, weight: signal.kind === 'export' ? signal.items : 1 });
    if (events.reduce((sum, event) => sum + event.weight, 0) >= rule.threshold) {
      // One alert per burst: the count starts again after it is raised.
      seen.delete(key);
      raise(rule.alert);
      return;
    }
    seen.set(key, events);
    if (seen.size > SWEEP_AT) sweep(at);
  }

  return { observe, tracked: () => seen.size };
}
