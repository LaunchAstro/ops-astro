// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P3: `invitation accepted` and `login created (person,
// business)`, on the one-time enrolment token alone. No one is signed in yet,
// so no person's grant is asked: the token is the authority, and the writes
// are the system's, as the business's worker, under that token.
//
// 1. Find the token. Its SHA-256 is looked for in every one of the
//    deployment's businesses, each under its own tenancy, whatever the token,
//    so the work done never depends on which business holds it. It is live
//    only while it is unspent, inside its lifetime, the newest its invitation
//    has (a resend's link replaces the one before), and its invitation is
//    pending and inside its own lifetime. Every other token, an unknown one
//    among them, is one answer: `ENROLMENT_LINK_INVALID`.
// 2. Make the login at the login provider, through custody under the
//    catalogued `auth.create_user` (`createLogin`), for the invited address,
//    with the password the page set and the address confirmed. An address
//    that already holds a login (in another business, or one an earlier
//    accept made) gets none: the answer is `sign_in`, and nothing is spent,
//    so its holder may accept once signed in (that binding is a follow-up).
//    A fault spends nothing and keeps nothing.
// 3. In one transaction, under the invitation's lock and every check again:
//    spend every unspent token of the invitation, mark it accepted, give its
//    one enduring person an acting identity, a membership in the invited
//    role and the confirmed address, map the new login to that person, and
//    write both audit events. The link then does nothing, and nothing here
//    opens a session: the person signs in with the login, as anyone does.

export const ACCEPT_OPERATION = 'invitation.accept';
export const LOGIN_CREATE_OPERATION = 'login.create';

export interface AcceptRequest {
  readonly token: string;
  readonly password: string;
}

export type AcceptResult =
  | { readonly ok: true; readonly state: 'enrolled' | 'sign_in' }
  | {
      readonly ok: false;
      readonly code: 'ENROLMENT_LINK_INVALID' | 'PASSWORD_INVALID' | 'ENROLMENT_UNAVAILABLE';
    };

/** Accept the invitation a one-time enrolment token names: not built yet, every link refused. */
export async function acceptInvitation(
  _database: unknown,
  _businesses: readonly string[],
  _broker: unknown,
  _request: AcceptRequest,
): Promise<AcceptResult> {
  return await Promise.resolve({ ok: false, code: 'ENROLMENT_LINK_INVALID' });
}
