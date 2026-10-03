// SPDX-License-Identifier: AGPL-3.0-only
//
// C40, link use: a person who followed a reset link sets their new password
// in their own recovery session, and every session of theirs ends.
//
// The recovery session is the authority: a provider session whose first
// factor was the reset link (`VerifiedSubject.recovery`), naming its session,
// unended, of a login mapped in at least one of the deployment's businesses.
// Anything else is one answer, `RESET_LINK_INVALID`, and the provider is not
// asked. A spent link, and a request that lost the claim, are recorded as
// refused in each business that knows the login (I13).
//
// The link is spent before the provider is asked: in one transaction its
// session is ended and every session of the login ends in every business
// (0063, keeping none), so no fault or lost answer after the provider is asked
// leaves an old session live here. Of any requests carrying the link at once,
// only the one whose ending wrote the row goes on. A provider fault after
// that spends the link too: every session of the login is ended again (a
// sign-in made while the provider was asked is after the claim's ending), the
// others and then the recovery session are signed out at the provider in case
// the password was set, and the person asks for another link. A password the
// provider refuses outright (`PASSWORD_REFUSED`, GoTrue's 422) is answered as
// such, so the person chooses another, with a new link.
//
// The password is set by the provider, asked with the person's own token
// (GoTrue `PUT /user`), never through custody and never with the service
// key. Its answer is shaped (`PasswordProvider`): only a user whose id is the
// token's subject is a yes. A fault or any other answer audits nothing.
//
// On the yes, in each business the login is mapped in, one transaction ends
// the sessions it has seen and every session of the login again (0063), and
// audits `account.password_changed`, with no password and no token in it.
// After commit, the provider signs out the other sessions, which revokes
// their refresh tokens (C58), then the recovery session.

import {
  claimProviderSession,
  endOtherSeenSessions,
  endSubjectSessions,
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
  /** Set the session's own login's password: the provider's user id, its no, or a fault. */
  setPassword(accessToken: string, password: string): Promise<PasswordAnswer>;
}

/** The provider's definitive no to this password (weak, leaked, the same). */
export const PASSWORD_REFUSED = 'password_refused';

export type PasswordAnswer =
  ProviderAnswer<string> | { readonly ok: false; readonly fault: typeof PASSWORD_REFUSED };

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
      readonly code:
        'RESET_LINK_INVALID' | 'PASSWORD_INVALID' | 'RESET_PASSWORD_REFUSED' | 'RESET_UNAVAILABLE';
    };

const INVALID = { ok: false, code: 'RESET_LINK_INVALID' } as const;

/** The login in one business: its person and actor there. */
interface Mapped {
  readonly business: BusinessId;
  readonly personId: string;
  readonly actorId: string;
}

/**
 * Where the login stands, business by business: its person and actor. A
 * refusal is recorded where the login is known; a business that does not know
 * it is not handed its digest.
 */
async function mappedIn(
  database: Database,
  businesses: readonly BusinessId[],
  presented: VerifiedSubject,
): Promise<Mapped[]> {
  const found: Mapped[] = [];
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

/**
 * End the link's session, once, and with it every session of the login in
 * every business: false when another request ended it first, recorded in each
 * business the login is mapped in.
 */
async function claimed(
  database: Database,
  mapped: readonly [Mapped, ...Mapped[]],
  presented: VerifiedSubject,
  sessionId: string,
): Promise<boolean> {
  const won = await database.withBusiness(mapped[0].business, async (tx) => {
    if (!(await claimProviderSession(tx, sessionId))) return false;
    await endSubjectSessions(tx, presented.subject);
    return true;
  });
  if (won) return true;
  for (const { business } of mapped) {
    // oxlint-disable-next-line no-await-in-loop -- one business's record at a time
    await database.withBusiness(business, async (tx) => {
      await recordAuthenticationAttempt(tx, {
        owner: 'person_login',
        presented,
        outcome: 'refused',
        refusalCode: 'AUTH_SESSION_EXPIRED',
      });
    });
  }
  return false;
}

/**
 * After a failure past the claim: every session of the verified login ends
 * again, then the provider signs out the others and the recovery session, so
 * the spent link's token asks it nothing more.
 */
async function failedAfterClaim(
  database: Database,
  business: BusinessId,
  provider: PasswordProvider,
  reset: PasswordReset,
): Promise<void> {
  try {
    await database.withBusiness(business, async (tx) => {
      await endSubjectSessions(tx, reset.presented.subject);
    });
  } finally {
    await provider.signOut(reset.accessToken, 'others');
    await provider.signOut(reset.accessToken, 'local');
  }
}

/** In each business the login is mapped in: end its seen sessions, and audit the change. */
async function changedIn(
  database: Database,
  mapped: readonly Mapped[],
  subject: string,
): Promise<void> {
  for (const { business, personId, actorId } of mapped) {
    // oxlint-disable-next-line no-await-in-loop -- one business's transaction at a time
    await database.withBusiness(business, async (tx) => {
      await endOtherSeenSessions(tx, personId, undefined, 'end_others', subject);
      await writeAuditEvent(tx, {
        actorId,
        command: PASSWORD_CHANGED,
        outcome: 'applied',
        refusalCode: null,
        payloadDigest: payloadDigest({ command: PASSWORD_CHANGED, person: personId }),
      });
    });
  }
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
  const [first, ...rest] = mapped;
  if (first === undefined) return INVALID;
  const bytes = Buffer.byteLength(reset.password, 'utf8');
  if (bytes < PASSWORD_BYTES.least || bytes > PASSWORD_BYTES.most) {
    return { ok: false, code: 'PASSWORD_INVALID' };
  }
  if (!(await claimed(database, [first, ...rest], presented, sessionId))) return INVALID;
  const set = await provider.setPassword(accessToken, reset.password);
  if (!set.ok || set.value !== presented.subject) {
    // Not set, or set with the answer lost: every session ends again.
    await failedAfterClaim(database, first.business, provider, reset);
    const refused = !set.ok && set.fault === PASSWORD_REFUSED;
    return { ok: false, code: refused ? 'RESET_PASSWORD_REFUSED' : 'RESET_UNAVAILABLE' };
  }
  try {
    await changedIn(database, mapped, presented.subject);
  } catch (fault) {
    await failedAfterClaim(database, first.business, provider, reset);
    throw fault;
  }
  const others = await provider.signOut(accessToken, 'others');
  const local = await provider.signOut(accessToken, 'local');
  return { ok: true, signedOutAtProvider: others.ok && local.ok };
}
