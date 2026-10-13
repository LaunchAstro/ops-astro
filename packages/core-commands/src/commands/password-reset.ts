// SPDX-License-Identifier: AGPL-3.0-only
//
// Password reset on the login provider's one-time recovery session. The
// person's browser writes the password to the provider; nothing here sees
// one. These steps record the request, open the reset's window before the
// browser's write, and settle it after.
//
// 1. Request. Every address takes the same statement
//    (`ops.password_reset_request`, 20261013060059), which counts and inserts
//    under advisory locks on the address's digest and then the caller's: 3
//    an hour per address, 10 per caller, nothing recorded over either.
// 2. Begin, in one transaction: the login's factor lock first (C59's, which
//    a factor's verification and a mapping's write take too), then the
//    session's window, if it has one, is the answer (unsettled: the same
//    window; settled: refused). Otherwise one link the M5 unit minted for the
//    login is consumed: minted inside the link's life and no later than the
//    session's sign-in, so a session our link did not open (a sign-in link)
//    is refused. Then, judged live under the lock, a login mapped nowhere is
//    refused, and a login with a verified authenticator anywhere needs
//    support. Last the window opens (`openResetWindow`, under the login's
//    session-ending key) and is recorded against the session's digest. From
//    that commit every session of the login, in every business, is ended up
//    to the window's bound, the recovery session's own included.
// 3. Settle, once the provider has shown the write (the route's check): in
//    the database clock's next whole second, under the login's ending keys,
//    the session's window settles, its reset with it, and the first business
//    the login is mapped in audits `account.password_reset` once, as the
//    person it maps there, with a digest alone. A window already settled
//    settles nothing and audits nothing.

import { createHash } from 'node:crypto';
import {
  holdSubjectEnding,
  lockLoginFactors,
  loginHasVerifiedFactor,
  openResetWindow,
  settleResetWindow,
  waitForNextSecond,
  type Database,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import { writeAuditEvent } from './audit.ts';

/** The audit command a settled reset records. */
export const RESET_AUDIT_COMMAND = 'account.password_reset';

/** A business-less transaction's business: these rows are installation-wide. */
const NO_BUSINESS = '00000000-0000-0000-0000-000000000000';

/** The provider's recovery session, as `recoveryBearer` verified it. */
export interface RecoverySession {
  readonly subject: string;
  readonly sessionId: string;
  /** The session's sign-in, the provider's `otp` stamp, in whole seconds. */
  readonly signedInAt: number;
}

export type BeginCode = 'RESET_LINK_INVALID' | 'RESET_NEEDS_SUPPORT';

export type BeginResult = { readonly ok: true } | { readonly ok: false; readonly code: BeginCode };

const refused = (code: BeginCode): BeginResult => ({ ok: false, code });

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Step 1: one request, recorded or not by its limits; the caller learns nothing either way. */
export async function requestPasswordReset(
  database: Database,
  address: string,
  caller: string,
): Promise<void> {
  await database.withBusiness(NO_BUSINESS, async (tx) => {
    await tx.query('select ops.password_reset_request($1, $2)', [address, caller]);
  });
}

interface Window {
  readonly reset_id: string;
  readonly opened_at: Date;
  readonly settled: boolean;
}

/** The session's window, its reset the login's own. */
async function windowOf(tx: TenantQuery, session: RecoverySession): Promise<Window | undefined> {
  const [held] = await tx.query<Window>(
    `select r.reset_id::text as reset_id, r.opened_at, r.settled_at is not null as settled
       from ops.recovery_resets r join ops.subject_resets s on s.id = r.reset_id
      where r.session_digest = $1 and s.subject_digest = $2`,
    [digest(session.sessionId), digest(session.subject)],
  );
  return held;
}

/** The first business, by id, the login is mapped live in, or none. */
async function mappedIn(tx: TenantQuery, subject: string): Promise<string | undefined> {
  const [row] = await tx.query<{ readonly business: string | null }>(
    'select ops.recovery_subject_business($1)::text as business',
    [subject],
  );
  return row?.business ?? undefined;
}

/** Step 2: open the session's one window, or say why not. */
export async function beginPasswordReset(
  database: Database,
  session: RecoverySession,
): Promise<BeginResult> {
  return await database.withBusiness(NO_BUSINESS, async (tx) => {
    await lockLoginFactors(tx, session.subject);
    const held = await windowOf(tx, session);
    if (held !== undefined) return held.settled ? refused('RESET_LINK_INVALID') : { ok: true };
    const [link] = await tx.query<{ readonly consumed: boolean }>(
      'select ops.recovery_link_consume($1, to_timestamp($2)) as consumed',
      [session.subject, session.signedInAt],
    );
    if (link?.consumed !== true) return refused('RESET_LINK_INVALID');
    if ((await mappedIn(tx, session.subject)) === undefined) return refused('RESET_LINK_INVALID');
    if (await loginHasVerifiedFactor(tx, session.subject)) return refused('RESET_NEEDS_SUPPORT');
    const reset = await openResetWindow(tx, session.subject);
    await tx.query(
      'insert into ops.recovery_resets (session_digest, reset_id) values ($1, $2::uuid)',
      [digest(session.sessionId), reset],
    );
    return { ok: true };
  });
}

/** When the session's window opened, while it is open; settled or none, nothing. */
export async function openWindowOf(
  database: Database,
  session: RecoverySession,
): Promise<Date | undefined> {
  const held = await database.withBusiness(NO_BUSINESS, async (tx) => await windowOf(tx, session));
  return held === undefined || held.settled ? undefined : held.opened_at;
}

/** The person the login maps in the transaction's business, and their acting identity. */
async function mappedPerson(
  tx: TenantQuery,
  subject: string,
): Promise<{ readonly actor_id: string; readonly person_id: string } | undefined> {
  const [found] = await tx.query<{ readonly actor_id: string; readonly person_id: string }>(
    `select a.id::text as actor_id, a.person_id::text as person_id
       from public.logins l
       join public.person_logins pl
         on pl.business_id = l.business_id and pl.login_id = l.id and pl.active
       join public.actors a
         on a.business_id = pl.business_id and a.person_id = pl.person_id
        and a.kind = 'person' and a.active
      where l.business_id = $1 and l.provider = 'supabase' and l.subject = $2
      order by a.id limit 1`,
    [tx.businessId, subject],
  );
  return found;
}

/** Step 3: settle the session's window once, auditing once; a settled one is left alone. */
export async function settlePasswordReset(
  database: Database,
  session: RecoverySession,
): Promise<void> {
  const business = await database.withBusiness(
    NO_BUSINESS,
    async (tx) => await mappedIn(tx, session.subject),
  );
  await waitForNextSecond(database, business ?? NO_BUSINESS, async (tx) => {
    // A settle ends sessions signed in after the window's bound too, so a
    // write that read one of the login's sessions live commits first (C52-A).
    await holdSubjectEnding(tx, session.subject);
    const [settled] = await tx.query<{ readonly reset_id: string }>(
      `update ops.recovery_resets set settled_at = clock_timestamp()
        where session_digest = $1 and settled_at is null
       returning reset_id::text as reset_id`,
      [digest(session.sessionId)],
    );
    if (settled === undefined) return;
    await settleResetWindow(tx, settled.reset_id);
    const person = business === undefined ? undefined : await mappedPerson(tx, session.subject);
    if (person === undefined) return;
    await writeAuditEvent(tx, {
      actorId: person.actor_id,
      command: RESET_AUDIT_COMMAND,
      outcome: 'applied',
      refusalCode: null,
      payloadDigest: payloadDigest({ command: RESET_AUDIT_COMMAND, person: person.person_id }),
    });
  });
}
