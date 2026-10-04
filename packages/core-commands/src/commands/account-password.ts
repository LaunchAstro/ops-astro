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
// 3. A login with a verified second factor gives its code, checked by us
//    under C59's wrong-code lockout (`account-factor-checks.ts`) through the
//    factor check the composition root hands in. No provider assurance level
//    is read. A missing or wrong code is `RESET_FACTOR_INVALID`, and the
//    token is not spent, so the person tries again inside its life.
// 4. Spend it, under the token row's lock: every live token of the login is
//    spent and every session of the login ends in every business (0063,
//    keeping none), in one transaction. Of any requests carrying the token at
//    once, only the one that spent it goes on.
// 5. Set the password at the provider through custody (`setLoginPassword`,
//    `auth.update_user_password`), never with a key this process holds. A
//    no to the password itself is `RESET_PASSWORD_REFUSED`; a fault is
//    `RESET_UNAVAILABLE`. Either way the token is spent and every session of
//    the login ends again, and the person asks for a new link.
// 6. In each business the login is mapped in, one transaction audits
//    `account.password_changed`, with no password and no token in it, and
//    then ends the sessions it has seen and every session of the login again,
//    up to the moment that ending is written.

import { createHash, randomUUID } from 'node:crypto';
import {
  endOtherSeenSessions,
  endSubjectSessions,
  liveFactor,
  NO_ASSURANCE,
  standingOf,
  type BusinessId,
  type Database,
  type Session,
  type TenantQuery,
  type VerifiedSubject,
} from '../../../core-records/src/index.ts';
import { setLoginPassword, type Broker } from '../../../core-custody/src/index.ts';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import { recordCode, wrongCodeLock } from './account-factor-checks.ts';
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

/** A second-factor code checked for a login with no session of the person's. */
export type FactorCodeCheck = (
  subject: string,
  providerFactorId: string,
  code: string,
) => Promise<'good' | 'wrong' | 'fault'>;

export interface PasswordReset {
  readonly token: string;
  readonly password: string;
  readonly code?: string;
}

export interface ResetDependencies {
  readonly broker: Broker;
  /** Absent, a login with a verified factor cannot reset (`RESET_UNAVAILABLE`). */
  readonly checkFactor?: FactorCodeCheck;
}

export type PasswordResetCode =
  | 'RESET_LINK_INVALID'
  | 'PASSWORD_INVALID'
  | 'RESET_FACTOR_INVALID'
  | 'SECOND_FACTOR_LOCKED'
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

/** The login in one business, and its verified factor's provider id when it has one. */
interface Mapped {
  readonly business: BusinessId;
  readonly session: Session;
  readonly factorId?: string;
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
            and t.spent_at is null and t.expires_at > now()`,
        [business, tokenId],
      ),
  );
  return row === undefined ? undefined : { business, tokenId, subject: row.subject };
}

/** Step 2: where the login stands in each business, with its factor where it holds one. */
async function mappedIn(
  database: Database,
  businesses: readonly BusinessId[],
  presented: VerifiedSubject,
): Promise<Mapped[]> {
  const found: Mapped[] = [];
  for (const business of businesses) {
    // oxlint-disable-next-line no-await-in-loop -- one business at a time, every one of them
    const mapped = await database.withBusiness(business, async (tx) => {
      const strict = await standingOf(tx, presented, 'required');
      if (!('refused' in strict)) return { business, session: strict };
      if (strict.code !== 'AUTH_SECOND_FACTOR_REQUIRED') return null;
      const session = await standingOf(tx, presented, 'enrolling');
      if ('refused' in session) return null;
      const factor = await liveFactor(tx, session.personId);
      return { business, session, factorId: factor?.providerFactorId ?? '' };
    });
    if (mapped !== null) found.push(mapped);
  }
  return found;
}

/** Step 3: the code checked under the wrong-code lockout; undefined when it is good. */
async function factorRefusal(
  database: Database,
  check: FactorCodeCheck | undefined,
  at: Mapped & { readonly factorId: string },
  presented: VerifiedSubject,
  code: string | undefined,
): Promise<PasswordResetResult | undefined> {
  if (code === undefined || !/^[0-9]{6}$/u.test(code)) return refused('RESET_FACTOR_INVALID');
  if (check === undefined) return refused('RESET_UNAVAILABLE');
  const attempt = randomUUID();
  const caller = { presented, attempt };
  const lockout = await database.withBusiness(at.business, async (tx) => {
    const refusal = await wrongCodeLock(tx, presented.subject);
    await recordCode(tx, at.session, caller, 'before', refusal);
    return refusal;
  });
  if (lockout !== undefined) return refused('SECOND_FACTOR_LOCKED');
  const answer = await check(presented.subject, at.factorId, code);
  if (answer === 'fault') return refused('RESET_UNAVAILABLE');
  if (answer === 'wrong') return refused('RESET_FACTOR_INVALID');
  await database.withBusiness(at.business, async (tx) => {
    await recordCode(tx, at.session, { ...caller, proven: true }, 'after', lockout);
  });
  return undefined;
}

/** Step 4, under the token's lock: false when it was spent or died meanwhile. */
async function spend(tx: TenantQuery, found: Found): Promise<boolean> {
  const [live] = await tx.query<{ login_id: string }>(
    `select login_id from password_reset_tokens
      where business_id = $1 and id = $2 and spent_at is null and expires_at > now()
      for update`,
    [tx.businessId, found.tokenId],
  );
  if (live === undefined) return false;
  await tx.query(
    `update password_reset_tokens set spent_at = now()
      where business_id = $1 and login_id = $2 and spent_at is null`,
    [tx.businessId, live.login_id],
  );
  await endSubjectSessions(tx, found.subject);
  return true;
}

/** Step 6, in each business the login is mapped in. */
async function changedIn(database: Database, mapped: readonly Mapped[], subject: string) {
  for (const { business, session } of mapped) {
    // oxlint-disable-next-line no-await-in-loop -- one business's transaction at a time
    await database.withBusiness(business, async (tx) => {
      await writeAuditEvent(tx, {
        actorId: session.actorId,
        command: RESET_COMMAND,
        outcome: 'applied',
        refusalCode: null,
        payloadDigest: payloadDigest({ command: RESET_COMMAND, person: session.personId }),
      });
      // Last, so its ending reaches every session opened while this ran.
      await endOtherSeenSessions(tx, session.personId, undefined, 'end_others', subject);
    });
  }
}

/** Every session of the login ends again, after a failure past the spend. */
async function endAgain(database: Database, found: Found): Promise<void> {
  await database.withBusiness(found.business, async (tx) => {
    await endSubjectSessions(tx, found.subject);
  });
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
  const mapped = await mappedIn(database, businesses, presented);
  if (mapped.length === 0) return refused('RESET_LINK_INVALID');
  const factored = mapped.find((one): one is Mapped & { factorId: string } => 'factorId' in one);
  if (factored !== undefined) {
    const { checkFactor } = dependencies;
    const refusal = await factorRefusal(database, checkFactor, factored, presented, reset.code);
    if (refusal !== undefined) return refusal;
  }
  const spent = await database.withBusiness(found.business, async (tx) => await spend(tx, found));
  if (!spent) return refused('RESET_LINK_INVALID');
  let set: Awaited<ReturnType<typeof setLoginPassword>> = 'fault';
  let changed = false;
  try {
    set = await setLoginPassword(dependencies.broker, found.subject, reset.password);
    if (set === 'set') await changedIn(database, mapped, found.subject);
    changed = set === 'set';
  } finally {
    if (!changed) await endAgain(database, found);
  }
  if (changed) return { ok: true };
  return refused(set === 'refused' ? 'RESET_PASSWORD_REFUSED' : 'RESET_UNAVAILABLE');
}
