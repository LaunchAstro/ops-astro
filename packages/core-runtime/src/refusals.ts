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
import {
  REFUSAL_REGISTER,
  type RuntimeRefusalCode,
} from '../../core-records/src/commands/register.ts';

/**
 * The codes this module returns as its own. Declared once, in the refusal
 * register (`core-records/src/commands/register.ts`), on the rows marked
 * `runtime`, with each code's meaning and HTTP status beside it. The register
 * is L3's file and this module does not write to it; it reads the union from
 * it, so a runtime code and its registration cannot drift apart.
 */
export type { RuntimeRefusalCode };

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
 * Each runtime code with the status it is carried under, read from the
 * register rows marked `runtime`. It used to be a second table the runtime
 * suggested and a test compared with `apps/api/status.ts`; it is now a view of
 * the one table. Nothing in production reads it; it stays exported for the
 * tests that census the runtime's codes through it
 * (`tests/runtime/refusal-classes.test.ts`, `tests/commands/runtime-codes.test.ts`).
 */
export const SUGGESTED_STATUS: Readonly<Record<RuntimeRefusalCode, number>> = Object.fromEntries(
  REFUSAL_REGISTER.filter((row) => row.runtime).map((row) => [row.code, row.status]),
) as Record<RuntimeRefusalCode, number>;
