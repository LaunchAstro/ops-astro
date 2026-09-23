// SPDX-License-Identifier: AGPL-3.0-only
//
// The one fact both login paths and the attempt record start from.
//
// It lives in its own file rather than beside the person resolver because the
// attempt record is written by that resolver and describes its input: keeping
// the type where the resolver is makes the two import each other, and a cycle
// between "who is this" and "write down that we were asked" is a cycle nobody
// can read an ordering out of.

/** A subject the auth provider has already verified. Never from a request body. */
export interface VerifiedSubject {
  readonly provider: string;
  readonly subject: string;
}
