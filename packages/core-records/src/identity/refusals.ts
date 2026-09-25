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

/**
 * The two codes the agent path adds, kept in their own union rather than
 * widened into `IdentityRefusalCode`.
 *
 * `commands/register.ts` derives its `RefusalCode` from that union, and the
 * register is L3's. Widening it here would reach into the command surface from
 * the identity module, which is the coupling the register exists to prevent.
 * These are exported for L3 to register with the rest.
 *
 * `AUTH_NO_AGENT_IDENTITY` is the agent login path's one refusal: no login
 * here, a login that belongs to a person, a deactivated mapping and a
 * deactivated agent actor all produce it, for the reason
 * `AUTH_NO_MEMBERSHIP` gives on the person side.
 *
 * `AUTH_SESSION_EXPIRED` is a verified token that has expired. It is its own
 * code because a client has to tell "sign in again" from "you may not see
 * this" and from "the server is broken". Only one of those is a re-login path,
 * and a silent failure is none of them.
 */
export type AgentIdentityRefusalCode = 'AUTH_NO_AGENT_IDENTITY' | 'AUTH_SESSION_EXPIRED';

export interface Refusal {
  readonly refused: true;
  readonly code: IdentityRefusalCode;
  /** What a person could do about it. Never a value, never a name. */
  readonly fixes: readonly string[];
}

/** The same shape, in the agent path's codes. Separate so the register stays L3's. */
export interface AgentRefusal {
  readonly refused: true;
  readonly code: AgentIdentityRefusalCode;
  readonly fixes: readonly string[];
}

export function refuse(code: IdentityRefusalCode, fixes: readonly string[]): Refusal {
  return { refused: true, code, fixes };
}

export function refuseAgent(
  code: AgentIdentityRefusalCode,
  fixes: readonly string[],
): AgentRefusal {
  return { refused: true, code, fixes };
}

/** The discriminant, so a caller can tell a result from a refusal. */
export function isRefusal(value: object): value is Refusal | AgentRefusal {
  return 'refused' in value && value.refused === true;
}
