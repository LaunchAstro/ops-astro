// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's own sessions (C58, 0057): the ones this business has served them
// lately, less the ones ended anywhere (0065).
//
// The sign-in provider gives a person no list of their sessions, so the list
// is what the door has seen: the distinct `session_id`s of the person's
// resolved attempts inside the absolute limit, less the ones already ended.
// Every statement names the business and the person, so a person reads and
// ends their own sessions and nobody else's.

import type { TenantQuery } from '../tenancy/database.ts';
import { SESSION_ABSOLUTE_SECONDS } from './verified-subject.ts';

export type SessionEndReason = 'sign_out' | 'end_others' | 'factor_change';

export interface SeenSession {
  readonly sessionId: string;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly current: boolean;
}

/**
 * Ends provider sessions installation-wide (0065): login resolution refuses a
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
  // Ended in every business the login reaches, not only this one (0065).
  await tx.query(END_PROVIDER_SESSIONS, [sessionIds]);
  return rows.length;
}
