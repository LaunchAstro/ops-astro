// SPDX-License-Identifier: AGPL-3.0-only
//
// Password reset on the login provider's one-time recovery session. The API's
// `changed` route takes the new password and writes it at the provider on
// that same session (`askUser`), never with an admin key; nothing here sees
// one. These steps record the request, open the reset's window before the
// route's write, name whom the write is audited as, and settle it after.
//
// 1. Request. Every address takes the same statement
//    (`ops.password_reset_request`, 20261013223000), which counts and inserts
//    under advisory locks on the address's digest and then the caller's: 3
//    an hour per address, 10 per caller, nothing recorded over either.
// 2. Begin, in one transaction: the login's factor lock first (C59's, which
//    a factor's verification and a mapping's write take too), then the
//    session's window, if it has one, is the answer (unsettled: the same
//    window; settled: refused). Otherwise one link the M5 unit minted for the
//    login is consumed: minted inside the link's life, no later than the
//    session's sign-in, and still the provider's latest mailed link (its
//    `recovery_sent_at`, as the route read it), so a session our link did not
//    open (a sign-in link, minted since) is refused. Then, judged live under the lock, a login mapped nowhere is
//    refused, and a login with a verified authenticator anywhere needs
//    support. Last the window opens (`openResetWindow`, under the login's
//    session-ending key) and is recorded against the session's digest, with
//    the recovery token's expiry as a record. From that commit every session
//    of the login, in every business, is ended up to the window's bound, the
//    recovery session's own included; and while the window is unsettled and
//    no later reset of the login has settled, a session signed in after the
//    bound is asked about at the provider (`ops.reset_write_open`), since the
//    recovery session, refreshed, can write for as long as the provider
//    keeps it.
// 3. Before the write: the session's window, with `WRITE_ROOM_SECONDS`
//    before its bound, and the first business the login is mapped in live,
//    with the person it maps there (`resetWriteTargetOf`). With either
//    missing, nothing is written. A mapping that ends while the write is out
//    leaves that person the reset's audit target.
// 4. Settle, once the route's own password write is acknowledged: in the
//    database clock's next whole second, under the login's ending keys, the
//    session's window settles, its reset with it, and the target's business
//    audits `account.password_reset` once, as that person, with a digest
//    alone. A window already settled settles nothing and audits nothing.

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

/** How long before its bound a window still takes the password write. */
export const WRITE_ROOM_SECONDS = 30;

/** A business-less transaction's business: these rows are installation-wide. */
const NO_BUSINESS = '00000000-0000-0000-0000-000000000000';

/** The provider's recovery session, as `recoveryBearer` verified it. */
export interface RecoverySession {
  readonly subject: string;
  readonly sessionId: string;
  /** The session's sign-in, the provider's `otp` stamp, in whole seconds. */
  readonly signedInAt: number;
  /** The session's token's `exp`, in whole seconds: past it, it writes nothing. */
  readonly expiresAt: number;
}

/** A recovery session as `begin` takes it: with the provider's latest link time. */
export interface BeginningSession extends RecoverySession {
  /** The provider's `recovery_sent_at` as the session's `GET /user` answered it. */
  readonly providerSentAt: string;
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
  readonly settled: boolean;
  /** Unsettled, with `WRITE_ROOM_SECONDS` left before its bound. */
  readonly writable: boolean;
}

/** The session's window, its reset the login's own. */
async function windowOf(tx: TenantQuery, session: RecoverySession): Promise<Window | undefined> {
  const [held] = await tx.query<Window>(
    `select r.reset_id::text as reset_id, r.settled_at is not null as settled,
            r.settled_at is null
              and clock_timestamp() < s.open_until - make_interval(secs => $3) as writable
       from ops.recovery_resets r join ops.subject_resets s on s.id = r.reset_id
      where r.session_digest = $1 and s.subject_digest = $2`,
    [digest(session.sessionId), digest(session.subject), WRITE_ROOM_SECONDS],
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
  session: BeginningSession,
): Promise<BeginResult> {
  return await database.withBusiness(NO_BUSINESS, async (tx) => {
    await lockLoginFactors(tx, session.subject);
    const held = await windowOf(tx, session);
    if (held !== undefined) return held.settled ? refused('RESET_LINK_INVALID') : { ok: true };
    const [link] = await tx.query<{ readonly consumed: boolean }>(
      'select ops.recovery_link_consume($1, to_timestamp($2), $3::timestamptz) as consumed',
      [session.subject, session.signedInAt, session.providerSentAt],
    );
    if (link?.consumed !== true) return refused('RESET_LINK_INVALID');
    if ((await mappedIn(tx, session.subject)) === undefined) return refused('RESET_LINK_INVALID');
    if (await loginHasVerifiedFactor(tx, session.subject)) return refused('RESET_NEEDS_SUPPORT');
    const reset = await openResetWindow(tx, session.subject);
    await tx.query(
      `insert into ops.recovery_resets (session_digest, reset_id, write_until)
       values ($1, $2::uuid, to_timestamp($3))`,
      [digest(session.sessionId), reset, session.expiresAt],
    );
    return { ok: true };
  });
}

/** Whom a password write is audited as: the person the login mapped when it was made. */
export interface ResetAuditTarget {
  readonly business: string;
  readonly actorId: string;
  readonly personId: string;
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

/**
 * Step 3: the audit target of the password write, read before it is made, or
 * none: no window open with room before its bound, or a login mapped nowhere.
 */
export async function resetWriteTargetOf(
  database: Database,
  session: RecoverySession,
): Promise<ResetAuditTarget | undefined> {
  const business = await database.withBusiness(NO_BUSINESS, async (tx) =>
    (await windowOf(tx, session))?.writable === true
      ? await mappedIn(tx, session.subject)
      : undefined,
  );
  if (business === undefined) return undefined;
  const person = await database.withBusiness(
    business,
    async (tx) => await mappedPerson(tx, session.subject),
  );
  return person && { business, actorId: person.actor_id, personId: person.person_id };
}

/** Step 4: settle the session's window once, auditing once as `target`; a settled one is left alone. */
export async function settlePasswordReset(
  database: Database,
  session: RecoverySession,
  target: ResetAuditTarget,
): Promise<void> {
  await waitForNextSecond(database, target.business, async (tx) => {
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
    await writeAuditEvent(tx, {
      actorId: target.actorId,
      command: RESET_AUDIT_COMMAND,
      outcome: 'applied',
      refusalCode: null,
      payloadDigest: payloadDigest({ command: RESET_AUDIT_COMMAND, person: target.personId }),
    });
  });
}
