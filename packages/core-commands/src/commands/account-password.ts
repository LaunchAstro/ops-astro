// SPDX-License-Identifier: AGPL-3.0-only
//
// C40, link use (ORCH77-C40B): a person who followed a reset link sets their
// new password with the link's one-time token, and every session of theirs
// ends. No provider session is trusted, opened or handed out: the token is
// the authority, and the answer carries no credential.
//
// 1. Find the token. Its SHA-256 is looked up once, by one narrow security
//    definer function that answers the business and the token's id, and only
//    for a hash exactly one business holds (`password_reset_token_find`). The
//    token is then read in its own business: live only while unspent and
//    inside its 30 minutes. Every other token, an unknown one among them, is
//    one answer: `RESET_LINK_INVALID`.
// 2. Where the token's login stands, business by business. A login mapped in
//    none of the deployment's businesses is `RESET_LINK_INVALID` too.
// 3. A login with a live verified second factor, in any business, cannot
//    reset by link (ORCH77-C40MFA): `RESET_NEEDS_SUPPORT`, before anything is
//    spent, whatever code is sent, so the token stays live, the password and
//    sessions stay as they were, and nothing is written. Support resets it.
//    A fault reading where the login stands is `RESET_UNAVAILABLE`, never a set.
//    A login the token's own business no longer admits is `RESET_LINK_INVALID`.
//    That admission is read here, before the locks, and not again: a person
//    deactivated there between this read and the spend still resets, a
//    decided risk (deactivation takes no lock the reset could share).
// 4. Spend it, in one transaction: under C59's login lock, which a factor's
//    verification takes too, then the token row's lock, the token is read
//    again (spent or past its life is `RESET_LINK_INVALID`) and so is the
//    login's factor (one verified meanwhile is `RESET_NEEDS_SUPPORT`, nothing
//    spent). Then every live token of the login is spent and the reset's
//    window opens (20261005074054): every session of the login, in every
//    business, ends up to the moment the window settles, and until then up
//    to its bound. Of any requests carrying the token at once, only the one
//    that spent it goes on.
// 5. Set the password at the provider through custody (`setLoginPassword`,
//    `auth.update_user_password`), never with a key this process holds. A
//    no to the password itself is `RESET_PASSWORD_REFUSED`; a fault is
//    `RESET_UNAVAILABLE`. Either way the token is spent, and the person asks
//    for a new link.
// 6. Set or not, each business the login is mapped in ends the sessions it
//    has seen, one transaction each. Last, whatever happened, one transaction
//    in the token's business ends its own, settles the window (a sign-in
//    after it is served) and, only when the password was set and every
//    business's ending committed, audits `account.password_changed` there,
//    once, with no password and no token in it. The other businesses keep
//    their ended sessions alone, and a failure anywhere audits nothing
//    anywhere.

import { createHash } from 'node:crypto';
import {
  endOtherSeenSessions,
  endSeenSessions,
  lockLoginFactors,
  loginHasVerifiedFactor,
  NO_ASSURANCE,
  openResetWindow,
  settleResetWindow,
  standingOf,
  waitForNextSecond,
  type BusinessId,
  type Database,
  type Session,
  type TenantQuery,
  type VerifiedSubject,
} from '../../../core-records/src/index.ts';
import {
  setLoginPassword,
  type Broker,
  type LoginPasswordSet,
} from '../../../core-custody/src/index.ts';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import { writeAuditEvent } from './audit.ts';

/** A password's bounds in UTF-8 bytes (C40). */
export const PASSWORD_BYTES = { least: 12, most: 72 } as const;

/** The audit command a reset's password set records. */
export const RESET_COMMAND = 'account.password_changed';

/** How long a reset token lives; the table's check holds the same bound. */
export const RESET_TOKEN_MINUTES = 30;

/** A token: 32 random bytes, base64url, 43 characters. */
const TOKEN = /^[\w-]{43}$/u;

/** A business-less transaction's business: the lookup reads no tenant's rows. */
const NO_BUSINESS = '00000000-0000-0000-0000-000000000000';

export interface PasswordReset {
  readonly token: string;
  readonly password: string;
}

export interface ResetDependencies {
  readonly broker: Broker;
}

export type PasswordResetCode =
  | 'RESET_LINK_INVALID'
  | 'PASSWORD_INVALID'
  | 'RESET_NEEDS_SUPPORT'
  | 'RESET_PASSWORD_REFUSED'
  | 'RESET_UNAVAILABLE';

export type PasswordResetResult =
  { readonly ok: true } | { readonly ok: false; readonly code: PasswordResetCode };

const refused = (code: PasswordResetCode): PasswordResetResult => ({ ok: false, code });

interface Found {
  readonly business: BusinessId;
  readonly tokenId: string;
  readonly subject: string;
}

/** The login in one business. */
interface Mapped {
  readonly business: BusinessId;
  readonly session: Session;
}

/** Step 1: the one business whose live token this is, among the deployment's, or none. */
async function find(
  database: Database,
  businesses: readonly BusinessId[],
  token: string,
): Promise<Found | undefined> {
  if (!TOKEN.test(token)) return undefined;
  const hash = createHash('sha256').update(token).digest('hex');
  const [at] = await database.withBusiness(
    NO_BUSINESS,
    async (tx) =>
      await tx.query<{ business: string | null; token: string | null }>(
        'select business_id as business, token_id as token from public.password_reset_token_find($1)',
        [hash],
      ),
  );
  const business = at?.business ?? null;
  const tokenId = at?.token ?? null;
  if (business === null || tokenId === null || !businesses.includes(business)) return undefined;
  const [row] = await database.withBusiness(
    business,
    async (tx) =>
      await tx.query<{ subject: string }>(
        `select l.subject from password_reset_tokens t
           join logins l on l.business_id = t.business_id and l.id = t.login_id
          where t.business_id = $1 and t.id = $2 and l.provider = 'supabase'
            and t.spent_at is null and t.expires_at > clock_timestamp()`,
        [business, tokenId],
      ),
  );
  return row === undefined ? undefined : { business, tokenId, subject: row.subject };
}

/** Step 2: where the login stands in each business, or `factored` when it holds a verified factor. */
async function mappedIn(
  database: Database,
  businesses: readonly BusinessId[],
  presented: VerifiedSubject,
): Promise<Mapped[] | 'factored'> {
  const found: Mapped[] = [];
  for (const business of businesses) {
    // oxlint-disable-next-line no-await-in-loop -- one business at a time, every one of them
    const mapped = await database.withBusiness(business, async (tx) => {
      const session = await standingOf(tx, presented, 'required');
      return 'refused' in session ? session : { business, session };
    });
    if (!('refused' in mapped)) found.push(mapped);
    else if (mapped.code === 'AUTH_SECOND_FACTOR_REQUIRED') return 'factored';
  }
  return found;
}

/** Step 4: the window's id once spent, or why not. */
async function spend(
  tx: TenantQuery,
  found: Found,
): Promise<{ readonly window: string } | 'invalid' | 'factored'> {
  await lockLoginFactors(tx, found.subject);
  const [held] = await tx.query<{ login_id: string }>(
    `select login_id from password_reset_tokens where business_id = $1 and id = $2 for update`,
    [tx.businessId, found.tokenId],
  );
  if (held === undefined) return 'invalid';
  // Read once the lock is held, at that moment, not when the wait began.
  const [state] = await tx.query<{ live: boolean }>(
    `select spent_at is null and expires_at > clock_timestamp() as live
       from password_reset_tokens where business_id = $1 and id = $2`,
    [tx.businessId, found.tokenId],
  );
  if (state?.live !== true) return 'invalid';
  if (await loginHasVerifiedFactor(tx, found.subject)) return 'factored';
  await tx.query(
    `update password_reset_tokens set spent_at = now()
      where business_id = $1 and login_id = $2 and spent_at is null`,
    [tx.businessId, held.login_id],
  );
  return { window: await openResetWindow(tx, found.subject) };
}

/**
 * Step 6: the sessions seen in a business end; given the `subject` (a reset
 * that set nothing), every session signed in until now too, to the instant
 * (0063), as the settle's second is not.
 */
const endIn = async (tx: TenantQuery, session: Session, subject?: string) =>
  await (subject === undefined
    ? endSeenSessions(tx, session.personId, undefined, 'end_others')
    : endOtherSeenSessions(tx, session.personId, undefined, 'end_others', subject));

/** Step 6's one audit row, in the token's business. */
const audited = async (tx: TenantQuery, session: Session) =>
  await writeAuditEvent(tx, {
    actorId: session.actorId,
    command: RESET_COMMAND,
    outcome: 'applied',
    refusalCode: null,
    payloadDigest: payloadDigest({ command: RESET_COMMAND, person: session.personId }),
  });

/** What steps 5 and 6 need once the token is spent. */
interface Spent {
  readonly found: Found;
  readonly mapped: readonly Mapped[];
  readonly own: Mapped;
  readonly window: string;
}

/** Steps 5 and 6: the provider's answer, the sessions ended, the window settled. */
async function setAndEnd(
  database: Database,
  broker: Broker,
  { found, mapped, own, window }: Spent,
  password: string,
): Promise<LoginPasswordSet> {
  let set: LoginPasswordSet = 'fault';
  let ended = false;
  const unset = () => (set === 'set' ? undefined : found.subject);
  try {
    try {
      set = await setLoginPassword(broker, found.subject, password);
    } finally {
      // Set or not, the sessions each business saw end there, so its list
      // agrees with its door; the token's business's
      // with the settle, below.
      for (const { business, session } of mapped.filter((one) => one !== own)) {
        // oxlint-disable-next-line no-await-in-loop -- one business's transaction at a time
        await database.withBusiness(business, async (tx) => await endIn(tx, session, unset()));
      }
    }
    ended = true;
  } finally {
    await database.withBusiness(found.business, async (tx) => {
      if (set === 'set') await waitForNextSecond(tx);
      await endIn(tx, own.session, unset());
      if (ended && set === 'set') await audited(tx, own.session);
      await settleResetWindow(tx, window);
    });
  }
  return set;
}

/** Set a new password with a reset token, then end every session of its login. */
export async function setPasswordByToken(
  database: Database,
  businesses: readonly BusinessId[],
  dependencies: ResetDependencies,
  reset: PasswordReset,
): Promise<PasswordResetResult> {
  const bytes = Buffer.byteLength(reset.password, 'utf8');
  if (bytes < PASSWORD_BYTES.least || bytes > PASSWORD_BYTES.most) {
    return refused('PASSWORD_INVALID');
  }
  const found = await find(database, businesses, reset.token);
  if (found === undefined) return refused('RESET_LINK_INVALID');
  const presented: VerifiedSubject = {
    provider: 'supabase',
    subject: found.subject,
    assurance: NO_ASSURANCE,
  };
  let mapped: Mapped[] | 'factored';
  try {
    mapped = await mappedIn(database, businesses, presented);
  } catch {
    return refused('RESET_UNAVAILABLE');
  }
  if (mapped === 'factored') return refused('RESET_NEEDS_SUPPORT');
  const own = mapped.find((one) => one.business === found.business);
  if (own === undefined) return refused('RESET_LINK_INVALID');
  const spent = await database.withBusiness(found.business, async (tx) => await spend(tx, found));
  if (spent === 'factored') return refused('RESET_NEEDS_SUPPORT');
  if (spent === 'invalid') return refused('RESET_LINK_INVALID');
  const set = await setAndEnd(
    database,
    dependencies.broker,
    { found, mapped, own, window: spent.window },
    reset.password,
  );
  if (set === 'set') return { ok: true };
  return refused(set === 'refused' ? 'RESET_PASSWORD_REFUSED' : 'RESET_UNAVAILABLE');
}
