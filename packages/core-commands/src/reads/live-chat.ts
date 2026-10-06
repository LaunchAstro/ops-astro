// SPDX-License-Identifier: AGPL-3.0-only
//
// C71 (CS-7.42): who may hear a team conversation on the live channel: a
// current member holding `chat:comment`, no one else (one NOT_FOUND for all).
// Nothing served or audited (C4 live-sync 6).

import {
  askedFor,
  currentConversations,
  subjectsOf,
  withSession,
  withStanding,
} from '../../../core-records/src/index.ts';
import type {
  BusinessId,
  Database,
  Session,
  TenantQuery,
  VerifiedSubject,
} from '../../../core-records/src/index.ts';
import {
  asCallerVisible,
  isCommandRefusal,
  refuseNotFound,
  type CommandRefusal,
} from '../commands/refusal.ts';
import type { AdmissionAt } from './execute.ts';

/** The conversations of these the session's person may hear now, in one statement. */
async function heard(
  tx: TenantQuery,
  session: Session,
  conversationIds: readonly string[] | 'any',
): Promise<ReadonlySet<string>> {
  if (askedFor(subjectsOf(session), { collection: 'chat', action: 'comment' }).length === 0) {
    return new Set();
  }
  return await currentConversations(tx, conversationIds, session.personId);
}

/**
 * Whether the caller may follow each conversation's topic: its id, or the
 * one NOT_FOUND. At the `door` the login is resolved as every request's is;
 * a `recheck` resolves the same standing and records nothing.
 */
export async function admitConversations(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  conversationIds: readonly string[],
  at: AdmissionAt,
): Promise<readonly (string | CommandRefusal)[] | CommandRefusal> {
  const within = at === 'door' ? withSession : withStanding;
  const outcome = await within(database, businessId, presented, async (tx, session) => {
    const admitted = await heard(tx, session, conversationIds);
    return conversationIds.map((id) => (admitted.has(id) ? id : asCallerVisible(refuseNotFound())));
  });
  return isCommandRefusal(outcome) ? asCallerVisible(outcome) : outcome;
}

/**
 * Whether `personId` is a current member of any of these conversations (or,
 * given `any`, of any conversation) now, asked on the board stream before it
 * says one moved; false unless the bearer still resolves to that same person.
 * Records nothing.
 */
export async function hearsConversation(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  personId: string,
  conversationIds: readonly string[] | 'any',
): Promise<boolean> {
  const outcome = await withStanding(database, businessId, presented, async (tx, session) =>
    session.personId === personId && (await heard(tx, session, conversationIds)).size > 0
      ? 'heard'
      : refuseNotFound(),
  );
  return outcome === 'heard';
}
