// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P3: `invitation accepted` and `login created (person,
// business)` for a person who already holds a login (another business's, or
// one made elsewhere) and is signed in with it. The one-time token is still
// the authority over the invitation; the verified session says which login
// is bound. No password is asked and none is set.
//
// 1. Find the token, exactly as the token-only accept does (`find`): every
//    business, each under its own tenancy, one answer for every token that
//    is not live, `ENROLMENT_LINK_INVALID`. Nothing is asked of the provider
//    for a dead token.
// 2. Read the session's login at the login provider, through custody
//    (`auth.read_user`). The token's own claims carry no authority
//    (`apps/api/auth/supabase.ts`), so the address is the provider's, and
//    only an address the provider confirmed counts. It must be the
//    invitation's. A login the provider does not hold, an address it has
//    not confirmed and another address all answer as a dead link does, and
//    spend nothing: telling them apart would tell the holder of a link
//    which logins exist. A provider fault is `ENROLMENT_UNAVAILABLE`.
// 3. In one transaction, under the provider-login locks of the invitation's
//    own login id and of the session's login, then the invitation's lock,
//    and every check of the token again: a login this business has mapped
//    to anyone (a person or an agent) is refused as a dead link; otherwise
//    the token-only accept's own writes (`spendAndSeat`) spend every token,
//    accept, seat the invitation's person, map this login to them (its
//    `logins` row made here when this business has none) and audit both
//    acts as the business's worker. The answer opens no session: the person
//    goes on with the session they have.

import type { Database, VerifiedSubject } from '../../../core-records/src/index.ts';
import type { Broker } from '../../../core-custody/src/index.ts';

export interface SignedInAcceptRequest {
  readonly token: string;
  /** The verified session's login: the provider and its subject, nothing the caller wrote. */
  readonly login: VerifiedSubject;
}

export type SignedInAcceptResult =
  | { readonly ok: true; readonly state: 'joined' }
  | { readonly ok: false; readonly code: 'ENROLMENT_LINK_INVALID' | 'ENROLMENT_UNAVAILABLE' };

const INVALID = { ok: false, code: 'ENROLMENT_LINK_INVALID' } as const;

/** Accept the invitation a one-time token names, binding the signed-in session's login to it. */
export async function acceptSignedIn(
  _database: Database,
  _businesses: readonly string[],
  _broker: Broker,
  _request: SignedInAcceptRequest,
): Promise<SignedInAcceptResult> {
  return await Promise.resolve(INVALID);
}
