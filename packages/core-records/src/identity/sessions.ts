// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's own sessions (C58, 0057): the ones this business has served them
// lately, less the ones ended anywhere (0061, 0063).
//
// The sign-in provider gives a person no list of their sessions, so the list
// is what the door has seen: the distinct `session_id`s of the person's
// resolved attempts inside the absolute limit, less the ones already ended.
// Every statement names the business and the person, so a person reads and
// ends their own sessions and nobody else's. `sessionEnded`, which login
// resolution asks, is the one exception: an ending holds in every business,
// so it names only the token's session and its subject's digest.

import type { TenantQuery } from '../tenancy/database.ts';
import {
  SESSION_ABSOLUTE_SECONDS,
  SIGN_IN_CLOCK_SKEW_SECONDS,
  type VerifiedSubject,
} from './verified-subject.ts';

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
const WINDOW_SECONDS = SESSION_ABSOLUTE_SECONDS + SIGN_IN_CLOCK_SKEW_SECONDS;

/**
 * Less the sessions an ending of the login's other sessions (0063) covers:
 * first served here at or before it. Login resolution refuses those (a
 * session's sign-in is no later than its first serving plus the minute of
 * clock), so the list follows what the door serves, but for a request served
 * in the instant the ending takes to commit, which stays listed.
 */
const SEEN = `
  select a.session_id::text as session_id, min(a.at) as first_seen, max(a.at) as last_seen
    from public.authentication_attempts a
    join public.logins l on l.business_id = a.business_id and l.id = a.login_id
   where a.business_id = $1
     and a.person_id = $2
     and a.outcome = 'resolved'
     and a.session_id is not null
     and a.at > now() - make_interval(secs => $3)
     and not exists (
       select 1 from ops.ended_provider_sessions e where e.session_id = a.session_id)
   group by a.session_id, l.subject
  having not exists (
       select 1 from ops.ended_subject_sessions s
        where s.subject_digest = encode(sha256(convert_to(l.subject, 'UTF8')), 'hex')
          and s.kept_session is distinct from a.session_id
          and min(a.at) <= s.ended_before)
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

/**
 * Whether the session the token belongs to has ended (C58): signed out, in any
 * business the login reaches (0061), or one of the login's other sessions
 * ended from any business (0063): not the kept one, first signed in at or
 * before that ending. A token naming no session has none to end.
 *
 * The first sign-in time is the provider's clock and the ending is this
 * database's, and the verifier serves a sign-in time up to
 * `SIGN_IN_CLOCK_SKEW_SECONDS` ahead. So a session signed in that much after
 * an ending is taken as signed in before it: a sign-in in the minute after
 * "end my other sessions" is refused once, and never a session the ending
 * should have ended served.
 */
export async function sessionEnded(tx: TenantQuery, presented: VerifiedSubject): Promise<boolean> {
  if (presented.sessionId === undefined) return false;
  const rows = await tx.query<{ readonly ended: boolean }>(
    `select exists (
       select 1 from ops.ended_provider_sessions where session_id = $1::uuid
     ) or exists (
       select 1 from ops.ended_subject_sessions s
        where s.subject_digest = encode(sha256(convert_to($2, 'UTF8')), 'hex')
          and s.kept_session is distinct from $1::uuid
          and to_timestamp($3::bigint) <= s.ended_before + make_interval(secs => $4)
     ) as ended`,
    [
      presented.sessionId,
      presented.subject,
      presented.assurance?.signedInAt ?? null,
      SIGN_IN_CLOCK_SKEW_SECONDS,
    ],
  );
  return rows[0]?.ended === true;
}
