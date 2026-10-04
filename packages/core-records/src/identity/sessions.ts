// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's own sessions (C58, 0057): the ones this business has served them
// lately, less the ones ended anywhere (0061).
//
// The sign-in provider gives a person no list of their sessions, so the list
// is what the door has seen: the distinct `session_id`s of the person's
// resolved attempts inside the absolute limit, less the ones already ended.
// Every statement names the business and the person, so a person reads and
// ends their own sessions and nobody else's.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import { SESSION_ABSOLUTE_SECONDS, type VerifiedSubject } from './verified-subject.ts';

export type SessionEndReason = 'sign_out' | 'end_others' | 'factor_change';

export interface SeenSession {
  readonly sessionId: string;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly current: boolean;
}

/**
 * Ends provider sessions installation-wide (0061): login resolution refuses a
 * token whose session is named there, in every business. Asking again changes
 * nothing.
 */
const END_PROVIDER_SESSIONS = `insert into ops.ended_provider_sessions (session_id)
  select ids.id from unnest($1::uuid[]) as ids (id)
  on conflict (session_id) do nothing`;

/** The most sessions one list names; a person has a handful, never hundreds. */
const LISTED = 50;

/** The limit plus the minute of clock the door allows a first sign-in time. */
const WINDOW_SECONDS = SESSION_ABSOLUTE_SECONDS + 60;

const SEEN = `
  select a.session_id::text as session_id, min(a.at) as first_seen, max(a.at) as last_seen
    from public.authentication_attempts a
   where a.business_id = $1
     and a.person_id = $2
     and a.outcome = 'resolved'
     and a.session_id is not null
     and a.at > now() - make_interval(secs => $3)
     and not exists (
       select 1 from ops.ended_provider_sessions e where e.session_id = a.session_id)
   group by a.session_id
   order by max(a.at) desc, a.session_id
   limit $4`;

/** The person's live sessions, newest first; `current` marks the one asking. */
export async function listSeenSessions(
  tx: TenantQuery,
  personId: string,
  currentSessionId: string | undefined,
): Promise<readonly SeenSession[]> {
  const rows = await tx.query<{
    readonly session_id: string;
    readonly first_seen: Date;
    readonly last_seen: Date;
  }>(SEEN, [tx.businessId, personId, WINDOW_SECONDS, LISTED]);
  return rows.map((row) => ({
    sessionId: row.session_id,
    firstSeenAt: row.first_seen,
    lastSeenAt: row.last_seen,
    current: row.session_id === currentSessionId,
  }));
}

/**
 * End every session the person has been seen on except `keep`, and answer
 * how many were ended. An ended session stays ended: a second ending of the
 * same one is not counted twice.
 */
export async function endOtherSeenSessions(
  tx: TenantQuery,
  personId: string,
  keep: string | undefined,
  reason: Exclude<SessionEndReason, 'sign_out'>,
  /** The login's provider subject: the ending holds in every business (0063). */
  subject: string,
): Promise<number> {
  await tx.query(
    `insert into ops.ended_subject_sessions (subject_digest, kept_session)
     values (encode(sha256(convert_to($1, 'UTF8')), 'hex'), $2::uuid)`,
    [subject, keep ?? null],
  );
  return await endSeenSessions(tx, personId, keep, reason);
}

/**
 * End the sessions the person has been seen on here except `keep`, by id
 * alone: a reset's window ends the rest (C40).
 */
export async function endSeenSessions(
  tx: TenantQuery,
  personId: string,
  keep: string | undefined,
  reason: Exclude<SessionEndReason, 'sign_out'>,
): Promise<number> {
  const seen = await tx.query<{ readonly session_id: string }>(
    `select distinct a.session_id::text as session_id
       from public.authentication_attempts a
      where a.business_id = $1 and a.person_id = $2 and a.outcome = 'resolved'
        and a.session_id is not null
        and a.at > now() - make_interval(secs => $3)`,
    [tx.businessId, personId, WINDOW_SECONDS],
  );
  const others = seen.map((row) => row.session_id).filter((id) => id !== keep);
  return await endSessions(tx, personId, others, reason);
}

/**
 * Open a reset's window (C40, 20261004101257): every session of the login, in
 * every business, is ended up to the moment the window settles, and until
 * then up to its bound, so a session opened while the reset is in flight is
 * ended even when the reset's last transaction never commits. Answers its id.
 */
export async function openResetWindow(tx: TenantQuery, subject: string): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into ops.subject_resets (id, subject_digest)
     values ($1::uuid, encode(sha256(convert_to($2, 'UTF8')), 'hex'))`,
    [id, subject],
  );
  return id;
}

/** Settle the window: a sign-in from this moment is served. */
export async function settleResetWindow(tx: TenantQuery, id: string): Promise<void> {
  await tx.query(
    `update ops.subject_resets set settled_at = clock_timestamp()
      where id = $1::uuid and settled_at is null`,
    [id],
  );
}

/**
 * Whether the session the token belongs to has ended (C58): signed out, in any
 * business the login reaches (0061), one of the login's other sessions ended
 * from any business (0063), not the kept one, first signed in at or before
 * that ending, or first signed in a whole second before a reset of the login
 * settled, or up to the bound of one still open (C40); a session refused while
 * one is open is ended, so it stays refused however the reset settles (Sol, PR
 * #382 round 3). A token naming no session has none to end.
 */
export async function sessionEnded(tx: TenantQuery, presented: VerifiedSubject): Promise<boolean> {
  if (presented.sessionId === undefined) return false;
  // GoTrue stamps a sign-in in whole seconds, rounded down. One stamped with
  // the settle's own second may follow the settle, and a new password's must
  // be served (round 3), so the settle refuses only a stamp whose whole second
  // had passed; comparing the stamp as an instant would refuse that sign-in.
  // What this serves from before the settle in that second was ended if the
  // door saw it (the reset's endings, or refused while open, below).
  const [row] = await tx.query<{ readonly ended: boolean; readonly open: boolean }>(
    `with reset as (
       select (to_timestamp($3::bigint) <= r.open_until and r.settled_at is null) as open,
              to_timestamp($3::bigint + 1) <= r.settled_at as settled
         from ops.subject_resets r
        where r.subject_digest = encode(sha256(convert_to($2, 'UTF8')), 'hex'))
     select exists (
       select 1 from ops.ended_provider_sessions where session_id = $1::uuid
     ) or exists (
       select 1 from ops.ended_subject_sessions s
        where s.subject_digest = encode(sha256(convert_to($2, 'UTF8')), 'hex')
          and s.kept_session is distinct from $1::uuid
          and to_timestamp($3::bigint) <= s.ended_before
     ) or exists (select 1 from reset where open or settled) as ended,
     exists (select 1 from reset where open) as open`,
    [presented.sessionId, presented.subject, presented.assurance?.signedInAt ?? null],
  );
  if (row?.open === true) await tx.query(END_PROVIDER_SESSIONS, [[presented.sessionId]]);
  return row?.ended === true;
}

/**
 * End one provider session in every business (0061), with no person: a
 * sign-out the business no longer admits still ends its verified session.
 */
export async function endProviderSession(tx: TenantQuery, sessionId: string): Promise<void> {
  await tx.query(END_PROVIDER_SESSIONS, [[sessionId]]);
}

/** End the one session the person is signing out of. */
export async function endOwnSession(
  tx: TenantQuery,
  personId: string,
  sessionId: string | undefined,
): Promise<number> {
  return sessionId === undefined ? 0 : await endSessions(tx, personId, [sessionId], 'sign_out');
}

async function endSessions(
  tx: TenantQuery,
  personId: string,
  sessionIds: readonly string[],
  reason: SessionEndReason,
): Promise<number> {
  if (sessionIds.length === 0) return 0;
  const rows = await tx.query(
    `insert into public.ended_sessions (business_id, person_id, session_id, reason)
     select $1, $2, ids.id, $4 from unnest($3::uuid[]) as ids (id)
     on conflict (business_id, person_id, session_id) do nothing
     returning 1`,
    [tx.businessId, personId, sessionIds, reason],
  );
  // Ended in every business the login reaches, not only this one (0061).
  await tx.query(END_PROVIDER_SESSIONS, [sessionIds]);
  return rows.length;
}
