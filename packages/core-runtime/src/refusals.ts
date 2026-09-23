// SPDX-License-Identifier: AGPL-3.0-only
//
// The runtime's refusal codes, and the decision shape every entry point
// returns.
//
// Returned, never thrown, for the same reason `authority/grants.ts` does it: a
// refusal is an answer about authority or state, and an exception is a report
// that the server broke. A caller that has to tell "you may not" from "it is
// down" cannot do it through a `catch`.
//
// `DELEGATION_EXCLUDES_DECISION` is deliberately **not** in this union. It is
// L2's code, produced by `checkDelegatedAuthority`, and `decide.ts` returns it
// unchanged rather than re-deriving it — a second module that decides for
// itself what an agent may decide is a second place that rule can drift.

import type {
  DelegationRefusal,
  DelegationRefusalCode,
} from '../../core-records/src/authority/delegations.ts';

export type RuntimeRefusalCode =
  /** The gate names a version that is no longer the live one. */
  | 'VERSION_SUPERSEDED'
  /** The gate's stored digest and the version's own disagree. */
  | 'EVIDENCE_MISMATCH'
  | 'GATE_NOT_FOUND'
  | 'GATE_ALREADY_DECIDED'
  | 'GATE_EXPIRED'
  /** The lineage is rejected or cancelled; only an authorised restart opens a new one. */
  | 'LINEAGE_TERMINAL'
  /** A third formal round (G08). */
  | 'CHANGE_ROUNDS_EXHAUSTED'
  /** The envelope cannot hold the accepted maximum. */
  | 'BUDGET_UNAVAILABLE'
  /** The cap has nothing left. Distinct from unavailable on purpose (W05). */
  | 'BUDGET_EXHAUSTED'
  /** The proposal asks for more than the caller's authority covers. */
  | 'PROPOSAL_OUT_OF_SCOPE'
  /** The named lineage belongs to a different task than the request does (R3). */
  | 'LINEAGE_NOT_ON_TASK'
  /** The request names a cap the task's existing envelope does not draw on (R2). */
  | 'CAP_BINDING_MISMATCH'
  /** This head dispatches nothing, so it has no observed expenditure to settle (R6). */
  | 'ACTUAL_EXPENDITURE_UNSUPPORTED'
  /**
   * The successor a handback asked for is outside the bounds a settlement may
   * propose within: the cap behind the envelope, that envelope's currency, or
   * the lineage's two formal rounds (R4, T4).
   */
  | 'SUCCESSOR_OUT_OF_BOUNDS'
  | 'RESERVATION_NOT_CLAIMABLE'
  | 'LEASE_HELD'
  | 'LEASE_NOT_OWNED'
  | 'LEASE_EXPIRED'
  | 'SCOPE_NOT_GRANTED';

export interface RuntimeRefusal {
  readonly code: RuntimeRefusalCode;
  readonly reason: string;
  readonly fix: string;
}

/** A runtime refusal, or one L2 produced and this module is passing through. */
export type AnyRefusal = RuntimeRefusal | DelegationRefusal;

export type RuntimeResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: AnyRefusal };

export function refuse(
  code: RuntimeRefusalCode,
  reason: string,
  fix: string,
): RuntimeResult<never> {
  return { ok: false, refusal: { code, reason, fix } };
}

export function isRuntimeRefusal(refusal: AnyRefusal): refusal is RuntimeRefusal {
  return !Object.hasOwn(DELEGATION_CODES, refusal.code);
}

// A record over L2's union rather than a list, so a delegation code L2 adds is
// a type error here instead of a code this module silently claims as its own.
// `DELEGATION_ALREADY_LIVE` was claimed that way until it was added.
const DELEGATION_CODES: Readonly<Record<DelegationRefusalCode, true>> = {
  DELEGATION_EXCLUDES_DECISION: true,
  DELEGATION_OUT_OF_PURPOSE: true,
  DELEGATION_NARROWED: true,
  DELEGATION_NOT_LIVE: true,
  DELEGATION_WIDENS: true,
  DELEGATION_ALREADY_LIVE: true,
};

/**
 * The status L3 should give each code when it registers them in
 * `apps/api/status.ts`. Suggested, not imposed: the HTTP surface is L3's file
 * and this module has no business writing to it.
 */
export const SUGGESTED_STATUS: Readonly<Record<RuntimeRefusalCode, number>> = {
  VERSION_SUPERSEDED: 409,
  EVIDENCE_MISMATCH: 409,
  GATE_NOT_FOUND: 404,
  GATE_ALREADY_DECIDED: 409,
  GATE_EXPIRED: 410,
  LINEAGE_TERMINAL: 409,
  CHANGE_ROUNDS_EXHAUSTED: 409,
  BUDGET_UNAVAILABLE: 409,
  BUDGET_EXHAUSTED: 402,
  PROPOSAL_OUT_OF_SCOPE: 403,
  LINEAGE_NOT_ON_TASK: 409,
  CAP_BINDING_MISMATCH: 409,
  ACTUAL_EXPENDITURE_UNSUPPORTED: 422,
  SUCCESSOR_OUT_OF_BOUNDS: 409,
  RESERVATION_NOT_CLAIMABLE: 409,
  LEASE_HELD: 409,
  LEASE_NOT_OWNED: 403,
  LEASE_EXPIRED: 410,
  SCOPE_NOT_GRANTED: 403,
};
