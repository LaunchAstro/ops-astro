// SPDX-License-Identifier: AGPL-3.0-only
//
// C40, link use: a person who followed a reset link sets their new password
// in their own recovery session, and every session of theirs ends.
//
// The recovery session is the authority: a provider session whose first
// factor was the reset link (`VerifiedSubject.recovery`), naming its session,
// unended, of a login mapped in at least one of the deployment's businesses.
// Anything else is one answer, `RESET_LINK_INVALID`, and the provider is not
// asked. A refusal is recorded in each business that knows the login (I13).
//
// The link is spent before the provider is asked: its session is ended in one
// transaction, and of any requests carrying it at once only the one whose
// ending wrote the row goes on. A provider fault after that spends the link
// too, and the person asks for another.
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
  claimProviderSession,
  endOtherSeenSessions,
  recordAuthenticationAttempt,
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

/** A password's bounds in UTF-8 bytes (C40). */
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

const INVALID = { ok: false, code: 'RESET_LINK_INVALID' } as const;

/**
 * Where the login stands, business by business: its person and actor. A
 * refusal is recorded where the login is known; a business that does not know
 * it is not handed its digest.
 */
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
    const standing = await database.withBusiness(business, async (tx) => {
      const known = await standingOf(tx, presented, 'recovering');
      if ('refused' in known && known.code !== 'AUTH_NO_MEMBERSHIP') {
        await recordAuthenticationAttempt(tx, {
          owner: 'person_login',
          presented,
          outcome: 'refused',
          refusalCode: known.code,
        });
      }
      return known;
    });
    if (!('refused' in standing)) {
      found.push({ business, personId: standing.personId, actorId: standing.actorId });
    }
  }
  return found;
}

/** End the link's session, once: false (recorded) when another request ended it first. */
async function claimed(
  database: Database,
  business: BusinessId,
  presented: VerifiedSubject,
  sessionId: string,
): Promise<boolean> {
  return await database.withBusiness(business, async (tx) => {
    if (await claimProviderSession(tx, sessionId)) return true;
    await recordAuthenticationAttempt(tx, {
      owner: 'person_login',
      presented,
      outcome: 'refused',
      refusalCode: 'AUTH_SESSION_EXPIRED',
    });
    return false;
  });
}

/** Set the new password in the recovery session, then end every session of the login. */
export async function setPasswordByRecovery(
  database: Database,
  businesses: readonly BusinessId[],
  provider: PasswordProvider,
  reset: PasswordReset,
): Promise<PasswordResetResult> {
  const { presented, accessToken } = reset;
  const sessionId = presented.recovery === true ? presented.sessionId : undefined;
  if (sessionId === undefined) return INVALID;
  const mapped = await mappedIn(database, businesses, presented);
  const first = mapped[0];
  if (first === undefined) return INVALID;
  const bytes = Buffer.byteLength(reset.password, 'utf8');
  if (bytes < PASSWORD_BYTES.least || bytes > PASSWORD_BYTES.most) {
    return { ok: false, code: 'PASSWORD_INVALID' };
  }
  if (!(await claimed(database, first.business, presented, sessionId))) return INVALID;
  const set = await provider.setPassword(accessToken, reset.password);
  if (!set.ok || set.value !== presented.subject) return { ok: false, code: 'RESET_UNAVAILABLE' };
  for (const { business, personId, actorId } of mapped) {
    // oxlint-disable-next-line no-await-in-loop -- one business's transaction at a time
    await database.withBusiness(business, async (tx) => {
      await endOtherSeenSessions(tx, personId, undefined, 'end_others', presented.subject);
      await writeAuditEvent(tx, {
        actorId,
        command: PASSWORD_CHANGED,
        outcome: 'applied',
        refusalCode: null,
        payloadDigest: payloadDigest({ command: PASSWORD_CHANGED, person: personId }),
      });
    });
  }
  const others = await provider.signOut(accessToken, 'others');
  const local = await provider.signOut(accessToken, 'local');
  return { ok: true, signedOutAtProvider: others.ok && local.ok };
}
