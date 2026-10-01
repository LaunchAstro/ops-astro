// SPDX-License-Identifier: AGPL-3.0-only
//
// The refusal codes identity can produce. The shape is the register's one
// `CommandRefusal`, with `names` always empty.
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
export type IdentityRefusalCode =
  | 'AUTH_UNKNOWN_LOGIN'
  | 'AUTH_NO_MEMBERSHIP'
  | 'ACTOR_INACTIVE'
  // C59: a person with a verified second factor signed in without it.
  | 'AUTH_SECOND_FACTOR_REQUIRED'
  // C58: a person's session they signed out of or ended from another; the
  // same re-login answer as a token past its time, which it now is.
  | 'AUTH_SESSION_EXPIRED';

/**
 * The two codes the agent path adds, kept in their own union rather than
 * widened into `IdentityRefusalCode`.
 *
 * `core-records/src/register.ts` derives its `RefusalCode` from that union, and the
 * register decides what a caller sees. Widening it here would reach into the
 * command surface from the identity module, which is the coupling the register
 * exists to prevent. These are exported for the register to declare with the
 * rest.
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
