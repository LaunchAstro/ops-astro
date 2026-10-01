// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-10: what a failed call was, from the evidence custody hands back, and
// whether a lookup's answer is proof that nothing happened.
//
// A failure is one of three drops or no drop at all:
//   - provider_unavailable: the provider answered that it is down or limiting
//     (a 429 or a 5xx). Its fault, with its code (`http_503`).
//   - connection_lost: the connection was cut and no answer arrived. The
//     network's, with no code.
//   - worker_lost: custody's process was lost mid-call. Ours.
// Anything else is no drop and carries a fault set from what was seen: a
// redirect, an answer too large or out of schema is the provider's; a
// timeout cannot say whose it was, so it is `undetermined`; a request custody
// would not send is ours. A failure carries the provider's refusal code, or
// null when none arrived. Only a code the operation declared at registration
// (`nothingHappened`) proves nothing happened; everything else is unknown.

import type { ModelOperation } from '../../core-connectors/src/index.ts';
import type { CustodyOutcome } from './custody.ts';
import type { OutboundFault } from './egress.ts';
import type { CallFault, DropCause, ProviderAdapter } from './broker-types.ts';

export interface Failure {
  readonly cause: DropCause | null;
  readonly fault: CallFault;
  readonly providerCode: string | null;
  readonly drop: 'dropped_worker_lost' | 'dropped_no_answer';
}

export const WORKER_LOST: Failure = {
  cause: 'worker_lost',
  fault: 'ours',
  providerCode: null,
  drop: 'dropped_worker_lost',
};

/** An answer that arrived but is not the operation's: the provider's, with no code. */
export const MALFORMED: Failure = {
  cause: null,
  fault: 'provider',
  providerCode: null,
  drop: 'dropped_no_answer',
};

const FAULTS: Readonly<Record<Exclude<OutboundFault, 'status'>, CallFault>> = {
  network: 'network',
  timeout: 'undetermined',
  redirect: 'provider',
  too_large: 'provider',
  unlisted: 'ours',
  bad_path: 'ours',
  forbidden: 'ours',
};

/** What a failed exchange was, from its fault and status alone. */
export function failureOf(fault: OutboundFault, status: number | null): Failure {
  const providerCode = status === null || status < 300 ? null : `http_${String(status)}`;
  const unknown = { providerCode, drop: 'dropped_no_answer' } as const;
  if (fault === 'network') return { ...unknown, cause: 'connection_lost', fault: 'network' };
  if (fault !== 'status') return { ...unknown, cause: null, fault: FAULTS[fault] };
  const down = status !== null && (status === 429 || status >= 500);
  return down
    ? { ...unknown, cause: 'provider_unavailable', fault: 'provider' }
    : { ...unknown, cause: null, fault: 'undetermined' };
}

/** Whether the operation declared `code` at registration as proof that nothing happened. */
export function declaresNothing(operation: ModelOperation, code: string | null): boolean {
  const proof = operation.nothingHappened;
  return code !== null && proof !== 'not_reconcilable' && proof.includes(code);
}

/** How an unknown call of this operation is reconciled: by asking its provider, or by a person. */
export function reconcileModeOf(
  operation: ModelOperation,
  adapter: ProviderAdapter | undefined,
): 'provider_lookup' | 'person' {
  const declared = operation.nothingHappened !== 'not_reconcilable';
  return declared && adapter?.lookup !== undefined && adapter.readLookup !== undefined
    ? 'provider_lookup'
    : 'person';
}

export type Proof =
  | { readonly proved: true; readonly code: string }
  | { readonly proved: false; readonly reason: string };

const nothing = (reason: string): Proof => ({ proved: false, reason });

/**
 * A lookup's answer: proof only when it arrived whole, inside custody's bounds,
 * in the lookup's own shape, with a code the operation declared. A redirect,
 * an oversized or slow answer, a cut connection, a malformed body, a claim in
 * the provider's own words and the provider saying it began all prove nothing.
 */
export function proofOf(
  outcome: CustodyOutcome,
  operation: ModelOperation,
  adapter: ProviderAdapter,
): Proof {
  if (outcome.kind === 'worker_lost') return nothing('custody was lost before the answer');
  if (outcome.kind === 'refused') return nothing(`custody refused the lookup (${outcome.code})`);
  if (!outcome.outbound.ok) {
    return nothing(`the lookup failed (${outcome.outbound.fault})`);
  }
  let body: unknown;
  try {
    body = JSON.parse(outcome.outbound.body);
  } catch {
    return nothing('the lookup answer is not JSON');
  }
  const code = adapter.readLookup?.(body);
  if (code === undefined) return nothing("the lookup answer is not the lookup's declared shape");
  if (!declaresNothing(operation, code)) {
    return nothing(
      `the provider answered ${code}, which is not declared proof that nothing happened`,
    );
  }
  return { proved: true, code };
}
