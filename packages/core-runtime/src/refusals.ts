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
// the authority module's code, produced by `checkDelegatedAuthority`, and
// `decide.ts` returns it unchanged rather than re-deriving it. A second module
// that decides for itself what an agent may decide is a second place that rule
// can drift.

import { REFUSAL_REGISTER, refuseCommand } from '../../core-records/src/index.ts';
import type {
  CommandRefusal,
  DelegationRefusalCode,
  RuntimeRefusalCode,
} from '../../core-records/src/index.ts';

/**
 * The codes this module returns as its own. Declared once, in the refusal
 * register (`core-records/src/register.ts`), on the rows marked `runtime`,
 * with each code's meaning and HTTP status beside it. This module reads the
 * union from it, so a runtime code and its registration cannot drift apart.
 */
export type { RuntimeRefusalCode };

/**
 * A runtime refusal, or one the delegation check produced and this module is
 * passing through, in the register's one shape: the reason first in `fixes`,
 * then the fix.
 */
export type RuntimeResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly refusal: CommandRefusal<RuntimeRefusalCode | DelegationRefusalCode>;
    };

export function refuse(
  code: RuntimeRefusalCode,
  reason: string,
  fix: string,
): RuntimeResult<never> {
  return { ok: false, refusal: refuseCommand(code, [], [reason, fix]) };
}

/**
 * Whether a refusal is one of the runtime's own: a register row marked
 * `runtime`, and not one of the delegation codes. It takes any refusal, so
 * it answers from the register rather than by elimination, or an identity
 * code such as `AUTH_UNKNOWN_LOGIN` would count as the runtime's.
 */
export function isRuntimeRefusal(
  refusal: CommandRefusal,
): refusal is CommandRefusal<RuntimeRefusalCode> {
  return RUNTIME_CODES.has(refusal.code) && !Object.hasOwn(DELEGATION_CODES, refusal.code);
}

const RUNTIME_CODES: ReadonlySet<string> = new Set(
  REFUSAL_REGISTER.filter((row) => row.runtime).map((row) => row.code),
);

// A record over the delegation union rather than a list, so a delegation code
// added there is a type error here instead of a code this module silently
// claims as its own. `DELEGATION_ALREADY_LIVE` was claimed that way until it
// was added.
const DELEGATION_CODES: Readonly<Record<DelegationRefusalCode, true>> = {
  DELEGATION_EXCLUDES_DECISION: true,
  DELEGATION_OUT_OF_PURPOSE: true,
  DELEGATION_NARROWED: true,
  DELEGATION_NOT_LIVE: true,
  DELEGATION_WIDENS: true,
  DELEGATION_ALREADY_LIVE: true,
};

/**
 * Each runtime code with the status it is carried under: a view of the
 * register rows marked `runtime`, so no second table can drift from the API's
 * own status map. Nothing in production reads it; it stays exported for the
 * tests that census the runtime's codes through it
 * (`tests/runtime/refusal-classes.test.ts`, `tests/commands/runtime-codes.test.ts`).
 */
export const SUGGESTED_STATUS: Readonly<Record<RuntimeRefusalCode, number>> = Object.fromEntries(
  REFUSAL_REGISTER.filter((row) => row.runtime).map((row) => [row.code, row.status]),
) as Record<RuntimeRefusalCode, number>;
