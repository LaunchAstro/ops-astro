// SPDX-License-Identifier: AGPL-3.0-only
//
// The one session rule login resolution asks (`ops.session_refusal`,
// 20261013044500), the carriage join's too. Apart from `sessions.ts` to keep
// it under the line limit.

import type { TenantQuery } from '../tenancy/database.ts';
import { END_PROVIDER_SESSIONS } from './sessions.ts';
import {
  SIGN_IN_CLOCK_SKEW_SECONDS,
  sessionProbeOf,
  type VerifiedSubject,
} from './verified-subject.ts';

/** Why login resolution refuses the session, by the one rule the carriage join asks too. */
export type SessionRefusal = 'AUTH_SESSION_EXPIRED' | 'AUTH_SECOND_FACTOR_REQUIRED';

/**
 * `ops.session_refusal` for a verified token (20261013044500): ended, as
 * `sessionEnded` reads it, or stopped at the password for a login with a
 * verified factor when `factorAsked`. The 12 hours are the verifier's, judged
 * before the database. A session refused while a reset is open is ended for
 * good, as `sessionEnded` records it.
 *
 * One more, outside the transaction's rows: a session first signed in after an
 * unsettled reset window's bound, while that window's recovery session, which
 * a refresh keeps alive, could still write a password and no later reset of
 * the login has settled (`ops.reset_write_open`). Such a write deletes the login's
 * other sessions at the provider and leaves nothing here, so the provider is
 * asked: gone is ended for good, and no answer is refused this once.
 */
export async function sessionRefusal(
  tx: TenantQuery,
  presented: VerifiedSubject,
  factorAsked: boolean,
): Promise<SessionRefusal | null> {
  const assurance = presented.assurance;
  // Nothing to ask, as before: no session to have ended, no factor to ask for.
  const short = assurance?.level !== 'aal2';
  if (presented.sessionId === undefined && !(factorAsked && short)) return null;
  const [row] = await tx.query<{
    readonly refusal: SessionRefusal | null;
    readonly ended: boolean;
    readonly open: boolean | null;
    readonly ask: boolean | null;
  }>(
    `select refusal, refusal is not distinct from 'AUTH_SESSION_EXPIRED' as ended, open, ask
       from (select ops.session_refusal($1, $2::uuid, $3, $4, $5, false) as refusal,
                    $2::uuid is not null
                      and (select open from ops.session_ended($2::uuid, $1, $3, $6)) as open,
                    $2::uuid is not null and $3::bigint is not null
                      and ops.reset_write_open($1, $3) as ask) s`,
    [
      presented.subject,
      presented.sessionId ?? null,
      assurance?.signedInAt ?? null,
      !short,
      factorAsked,
      SIGN_IN_CLOCK_SKEW_SECONDS,
    ],
  );
  if (row?.open === true) await tx.query(END_PROVIDER_SESSIONS, [[presented.sessionId]]);
  if (row?.refusal !== null && row?.refusal !== undefined) return row.refusal;
  if (row?.ask !== true) return null;
  const said = (await sessionProbeOf(presented)?.()) ?? 'unknown';
  if (said === 'gone') await tx.query(END_PROVIDER_SESSIONS, [[presented.sessionId]]);
  return said === 'live' ? null : 'AUTH_SESSION_EXPIRED';
}
