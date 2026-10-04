// SPDX-License-Identifier: AGPL-3.0-only
//
// C71 (CS-7.42): who may hear a team conversation on the live channel. A tab
// follows `conversation:<id>` as it follows a task, and the board stream says
// a conversation moved; both only to a current member of it, staff holding
// `chat:comment`, as `chat.messages` would admit them. The owner and
// administrators hold no way round it. Anything else is NOT_FOUND, one answer
// for another person's conversation, another business's, one the caller has
// left and an id never issued. Neither serves nor audits anything: the
// channel shows no content (C4 live-sync 6).

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

/**
 * The conversations of these the session's person may hear now: staff, a
 * current member and holding `chat:comment`, all asked in the one membership
 * statement; none to an agent key (API-2) that does not tick `chat:comment`.
 */
async function heard(
  tx: TenantQuery,
  session: Session,
  conversationIds: readonly string[],
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
 * Whether `personId` is a current member of any of these conversations now,
 * asked on the board stream before it says one moved; false unless the bearer
 * still resolves to that same person. Records nothing.
 */
export async function hearsConversation(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  personId: string,
  conversationIds: readonly string[],
): Promise<boolean> {
  const outcome = await withStanding(database, businessId, presented, async (tx, session) =>
    session.personId === personId && (await heard(tx, session, conversationIds)).size > 0
      ? 'heard'
      : refuseNotFound(),
  );
  return outcome === 'heard';
}
