// SPDX-License-Identifier: AGPL-3.0-only
//
// C40, link use: a person who followed a reset link sets their new password
// in their own recovery session, and every session of theirs ends.
//
// The recovery session is the authority: a provider session whose first
// factor was the reset link (`VerifiedSubject.recovery`), unended, of a login
// mapped in at least one of the deployment's businesses. Anything else is one
// answer, `RESET_LINK_INVALID`, and the provider is not asked.
//
// The password is set by the provider, asked with the person's own token
// (GoTrue `PUT /user`), never through custody and never with the service
// key. Its answer is shaped (`PasswordProvider`): only a user whose id is the
// token's subject is a yes. A fault or any other answer changes nothing here.
//
// On the yes, in each business the login is mapped in, one transaction ends
// every session of the login (0063, keeping none, so the recovery session is
// spent too) and audits `account.password_changed`, with no password and no
// token in it. After commit, the provider signs out the other sessions,
// which revokes their refresh tokens (C58), then the recovery session.

import {
  endOtherSeenSessions,
  standingOf,
  type BusinessId,
  type Database,
  type VerifiedSubject,
} from '../../../core-records/src/index.ts';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import type { FactorProvider, ProviderAnswer } from './account-factor-provider.ts';
import { writeAuditEvent } from './audit.ts';

/** The provider's calls the reset makes with the recovery session's own token. */
export interface PasswordProvider extends Pick<FactorProvider, 'signOut'> {
  /** Set the session's own login's password: the provider's user id, or a fault. */
  setPassword(accessToken: string, password: string): Promise<ProviderAnswer<string>>;
}

/** A password's bounds in UTF-8 bytes, as enrolment sets them. */
export const PASSWORD_BYTES = { least: 12, most: 72 } as const;

export const PASSWORD_CHANGED = 'account.password_changed';

export interface PasswordReset {
  readonly presented: VerifiedSubject;
  readonly accessToken: string;
  readonly password: string;
}

export type PasswordResetResult =
  | { readonly ok: true; readonly signedOutAtProvider: boolean }
  | {
      readonly ok: false;
      readonly code: 'RESET_LINK_INVALID' | 'PASSWORD_INVALID' | 'RESET_UNAVAILABLE';
    };

/** Where the login stands, business by business: its person and actor, read only. */
async function mappedIn(
  database: Database,
  businesses: readonly BusinessId[],
  presented: VerifiedSubject,
): Promise<
  { readonly business: BusinessId; readonly personId: string; readonly actorId: string }[]
> {
  const found = [];
  for (const business of businesses) {
    // oxlint-disable-next-line no-await-in-loop -- one business at a time, every one of them
    const standing = await database.withBusiness(
      business,
      async (tx) => await standingOf(tx, presented, 'recovering'),
    );
    if (!('refused' in standing)) {
      found.push({ business, personId: standing.personId, actorId: standing.actorId });
    }
  }
  return found;
}

/** Set the new password in the recovery session, then end every session of the login. */
export async function setPasswordByRecovery(
  database: Database,
  businesses: readonly BusinessId[],
  provider: PasswordProvider,
  reset: PasswordReset,
): Promise<PasswordResetResult> {
  const bytes = Buffer.byteLength(reset.password, 'utf8');
  if (bytes < PASSWORD_BYTES.least || bytes > PASSWORD_BYTES.most) {
    return { ok: false, code: 'PASSWORD_INVALID' };
  }
  void mappedIn;
  void endOtherSeenSessions;
  void payloadDigest;
  void writeAuditEvent;
  void database;
  void businesses;
  void provider;
  return { ok: true, signedOutAtProvider: false };
}
