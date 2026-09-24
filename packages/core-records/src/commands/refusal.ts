// SPDX-License-Identifier: AGPL-3.0-only
//
// One refusal shape at the command boundary, and the translation to what a
// caller is shown.
//
// Three shapes exist inside the core and each is right where it is. Identity's
// carries a code and fixes and deliberately no names, because which of several
// reasons applied is itself an inference across a tenancy boundary. The
// records engine's carries names, because the contract requires the field, the
// slot and the owning operation to be named. Authority's carries one reason
// and one fix as strings. A command can return any of the three, and a caller
// switching on `code` should not have to know which module the answer came
// from — so they are normalised here, at the boundary, rather than by editing
// three landed parts to share a type.
//
// The translation is the part with teeth. `asCallerVisible` is the only way a
// refusal leaves a command, and an audit-only code does not survive it: the
// register says `WRONG_BUSINESS` is recorded and never returned, so this turns
// it into the same `NOT_FOUND` a fabricated identifier gets — same code, same
// empty names, same fixes. Anything else is an inference channel, which is the
// leak composite tenant keys exist to close (ADR 0014:14).

import type { AgentRefusal, Refusal as IdentityRefusal } from '../identity/refusals.ts';
import type { RecordsRefusal } from '../records/refusals.ts';
import { CALLER_VISIBLE, registeredRefusal, type RefusalCode } from './register.ts';

export interface CommandRefusal {
  readonly refused: true;
  readonly code: RefusalCode;
  /**
   * In-business configuration by name: field keys, slot names, the owning
   * operation, a batch identity. Never a value the caller supplied — an
   * attempted value goes to the audit event and not to the response (T1-N4) —
   * and never anything belonging to another business.
   */
  readonly names: readonly string[];
  readonly fixes: readonly string[];
}

/**
 * The one constructor. It refuses an unregistered code, so a command cannot
 * invent a spelling: the register is the register, and a code that is not in
 * it has no meaning, no visibility rule and nothing for a caller to branch on.
 */
export function refuseCommand(
  code: RefusalCode,
  names: readonly string[],
  fixes: readonly string[],
): CommandRefusal {
  if (registeredRefusal(code) === undefined) {
    throw new Error(`refuseCommand: ${code} is not in the refusal register. Add it or use one.`);
  }
  return { refused: true, code, names, fixes };
}

const NOT_FOUND_FIXES: readonly string[] = [
  'Check the identifier against the one you were given.',
  'If you believe it exists, ask someone who can already see it to share it with you.',
];

/**
 * What a caller may be shown. An audit-only code becomes the answer a caller
 * would have got had the record never existed, with nothing left of the
 * original — the names go too, because a name is the inference.
 */
export function asCallerVisible(refusal: CommandRefusal): CommandRefusal {
  if (CALLER_VISIBLE.has(refusal.code)) return refusal;
  return { refused: true, code: 'NOT_FOUND', names: [], fixes: NOT_FOUND_FIXES };
}

/** The refusal a caller gets for a record that is not there, whatever the reason. */
export function refuseNotFound(): CommandRefusal {
  return refuseCommand('NOT_FOUND', [], NOT_FOUND_FIXES);
}

export function fromRecords(refusal: RecordsRefusal): CommandRefusal {
  return refuseCommand(refusal.code, refusal.names, refusal.fixes);
}

export function fromIdentity(refusal: IdentityRefusal): CommandRefusal {
  return refuseCommand(refusal.code, [], refusal.fixes);
}

/**
 * The agent login path's refusal, which is a different union from a person's.
 *
 * It is a separate function rather than a widened `fromIdentity` because the
 * two unions are separate on purpose: `AUTH_NO_AGENT_IDENTITY` is not one of
 * the answers a person's login may get, and a single translator taking both
 * would be the place someone later returns an agent code from the person path.
 * Both spellings are in the register, so the constructor still refuses an
 * invented one.
 */
export function fromAgentIdentity(refusal: AgentRefusal): CommandRefusal {
  return refuseCommand(refusal.code, [], refusal.fixes);
}

/**
 * A refusal that carries one reason and one fix. Authority's is one; the
 * runtime's and the delegation refusals it passes through are the others
 * (`fromReasoned` takes them all), so all three reach a caller in one
 * shape.
 */
export interface ReasonedRefusal {
  readonly code: RefusalCode;
  readonly reason: string;
  readonly fix: string;
}

/**
 * Any refusal that carries one reason and one fix, as the caller sees it:
 * authority's, the runtime's and the delegation refusals it passes through.
 * The runtime and delegation unions are taken from the register
 * (`RuntimeRefusalCode` from its rows marked `runtime`, and every delegation
 * code is a row), so there is no spelling here the register has never heard
 * of. One function under one name: it used to be two, `fromAuthority` and a
 * `fromRuntime` that only called it (THERMO-RECHECK NB6).
 */
export function fromReasoned(refusal: ReasonedRefusal): CommandRefusal {
  // The reason is a sentence about the rule, not about the caller's data, so
  // it can be shown. It goes in `fixes` beside the fix rather than into
  // `names`, which holds identifiers a reader looks up.
  return refuseCommand(refusal.code, [], [refusal.reason, refusal.fix]);
}

/**
 * An identity refusal, which `withSession` can return in place of a command
 * result. It is told apart by what it lacks: identity refusals carry no names,
 * on purpose, because which of several reasons applied is itself an inference
 * across a tenancy boundary.
 */
export function isIdentityRefusal(value: object): value is IdentityRefusal {
  return 'refused' in value && !('names' in value);
}

/** The discriminant every command result is read through. */
export function isCommandRefusal(value: object): value is CommandRefusal {
  return 'refused' in value && value.refused === true;
}
