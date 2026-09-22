// SPDX-License-Identifier: AGPL-3.0-only
//
// The typed refusal, in the three codes identity can produce.
//
// A refusal is returned, never thrown. Thrown refusals become error handling,
// and error handling is where a refusal turns into a 500 or, worse, into an
// empty result that reads like "there is nothing here" (minimum contract,
// section 4.4).
//
// Two properties every refusal below holds. It carries a stable machine code
// rather than a sentence, because a caller branches on the code and a person
// reads the sentence. And it carries no value the caller did not already
// present: not a person's name, not a business identifier, not which of the
// several possible reasons applied. What a refusal reveals is an inference
// channel, and the first slice's whole tenancy argument rests on closing it.
//
// The register itself is T1f's, along with the audit event every attempt
// writes. These three are the ones login resolution can reach.

/**
 * `AUTH_UNKNOWN_LOGIN` belongs to the provider verification step, which this
 * part does not implement: the Supabase Auth question is still open (minimum
 * contract, section 9), so resolution starts from a subject someone else has
 * already verified. It is named here because the code is the register's, not
 * this function's, and a caller switching on the union should see all three.
 */
export type IdentityRefusalCode = 'AUTH_UNKNOWN_LOGIN' | 'AUTH_NO_MEMBERSHIP' | 'ACTOR_INACTIVE';

export interface Refusal {
  readonly refused: true;
  readonly code: IdentityRefusalCode;
  /** What a person could do about it. Never a value, never a name. */
  readonly fixes: readonly string[];
}

export function refuse(code: IdentityRefusalCode, fixes: readonly string[]): Refusal {
  return { refused: true, code, fixes };
}

/** The discriminant, so a caller can tell a result from a refusal. */
export function isRefusal(value: object): value is Refusal {
  return 'refused' in value && value.refused === true;
}
