// SPDX-License-Identifier: AGPL-3.0-only
//
// The one fact both login paths and the attempt record start from.
//
// It lives in its own file rather than beside the person resolver because the
// attempt record is written by that resolver and describes its input: keeping
// the type where the resolver is makes the two import each other, and a cycle
// between "who is this" and "write down that we were asked" is a cycle nobody
// can read an ordering out of.

/** How strongly the provider says the caller signed in (C59). */
export type AssuranceLevel = 'aal1' | 'aal2';

export interface Assurance {
  readonly level: AssuranceLevel;
  readonly signedInAt: number | null;
  readonly factorAt: number | null;
}

export const NO_ASSURANCE: Assurance = { level: 'aal1', signedInAt: null, factorAt: null };

/**
 * A session's absolute limit (C58, the owner's ruling of 28 September 2026):
 * 12 hours from the first sign-in, set here and nowhere else. There is no idle
 * limit: a session left alone for hours inside the 12 is still a session.
 * Measured from `Assurance.signedInAt` (the provider's first-factor time,
 * which a refresh carries unchanged), never from a token's `iat`, which every
 * refresh moves.
 */
export const SESSION_ABSOLUTE_SECONDS: number = 12 * 60 * 60;

/** A subject the auth provider has already verified. Never from a request body. */
export interface VerifiedSubject {
  readonly provider: string;
  readonly subject: string;
  readonly assurance?: Assurance;
}
