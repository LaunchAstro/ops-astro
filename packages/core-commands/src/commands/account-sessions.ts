// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's own sessions (C58): see them, end the others, sign out
// of this one.
//
// Each act is a person's, on their own account, and served on the person
// prefix alone. Ending is recorded here first, in the serving transaction with
// its audit event, so the ended sessions are refused at the door from the
// commit (`AUTH_SESSION_EXPIRED`, 0057). The provider's sign-out, which
// revokes the refresh tokens, is asked after the commit and never inside a
// transaction; the answer says whether it confirmed, and nothing the provider
// says is kept or echoed. Asking again is always safe: an ended session stays
// ended and is not counted twice, and the provider's sign-out is idempotent.
//
// Ending sessions takes access away and gives none, so the act needs no lock
// of its own: two endings at once end the union of what each saw.

import {
  endOtherSeenSessions,
  endOwnSession,
  listSeenSessions,
  withSession,
  type Session,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import type { FactorCaller } from './account-factor.ts';
import type { FactorProvider, SessionsEnded } from './account-factor-provider.ts';
import { writeAuditEvent } from './audit.ts';
import { asCallerVisible, refuseCommand, type CommandRefusal } from './refusal.ts';

export interface SessionView {
  readonly sessionId: string;
  readonly current: boolean;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

const BODY_FIXES: readonly string[] = ['Send an empty JSON object, {}.'];

/** The person's live sessions, newest first, the one asking marked `current`. */
export async function listOwnSessions(
  caller: FactorCaller,
  body: unknown,
): Promise<{ readonly sessions: readonly SessionView[] } | CommandRefusal> {
  if (!isEmpty(body)) return refuseCommand('COMMAND_BODY_INVALID', [], BODY_FIXES);
  const outcome = await withSession(
    caller.database,
    caller.businessId,
    caller.presented,
    async (tx, session) => await listSeenSessions(tx, session.personId, caller.presented.sessionId),
  );
  if ('refused' in outcome) return asCallerVisible(outcome);
  return {
    sessions: outcome.map((row) => ({
      sessionId: row.sessionId,
      current: row.current,
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
    })),
  };
}

/** End every session but this one, here and then at the provider. */
export async function endOtherSessions(
  caller: FactorCaller,
  body: unknown,
  provider: FactorProvider,
): Promise<SessionsEnded | CommandRefusal> {
  return await endAndSignOut(caller, body, provider, 'others');
}

/**
 * Sign out of this session, here and then at the provider. Served at any
 * assurance: a person who has not yet given their code may still leave.
 */
export async function signOutSession(
  caller: FactorCaller,
  body: unknown,
  provider: FactorProvider,
): Promise<SessionsEnded | CommandRefusal> {
  return await endAndSignOut(caller, body, provider, 'local');
}

async function endAndSignOut(
  caller: FactorCaller,
  body: unknown,
  provider: FactorProvider,
  scope: 'others' | 'local',
): Promise<SessionsEnded | CommandRefusal> {
  if (!isEmpty(body)) return refuseCommand('COMMAND_BODY_INVALID', [], BODY_FIXES);
  const command = scope === 'others' ? 'account.sessions_end_others' : 'account.sign_out';
  const sessionId = caller.presented.sessionId;
  const end = async (tx: TenantQuery, session: Session) =>
    scope === 'others'
      ? await endOtherSeenSessions(
          tx,
          session.personId,
          sessionId,
          'end_others',
          caller.presented.subject,
        )
      : await endOwnSession(tx, session.personId, sessionId);
  const outcome = await withSession(
    caller.database,
    caller.businessId,
    caller.presented,
    async (tx, session) => {
      const ended = await end(tx, session);
      await writeAuditEvent(tx, {
        actorId: session.actorId,
        command,
        outcome: 'applied',
        refusalCode: null,
        payloadDigest: payloadDigest({ command, person: session.personId }),
      });
      return ended;
    },
    scope === 'local' ? 'enrolling' : 'required',
  );
  if (typeof outcome !== 'number') return asCallerVisible(outcome);
  const signedOut = await provider.signOut(caller.accessToken, scope);
  return { ended: outcome, signedOutAtProvider: signedOut.ok };
}

function isEmpty(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    Object.keys(body).length === 0
  );
}
