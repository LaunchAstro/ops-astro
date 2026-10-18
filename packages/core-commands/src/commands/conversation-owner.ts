// SPDX-License-Identifier: AGPL-3.0-only
//
// The one question every reader of a conversation's words asks first: is this
// session its owner? Its own module, so the context reader and the commands
// that import it can both ask it without importing each other.

import { isUuid } from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';

/** A person's message in a conversation, as the exchange names it. */
export interface Asked {
  readonly conversationId: string;
  readonly messageId: string;
}

/**
 * Whether the session owns the asked message's conversation, its body kept.
 * `contextOf` asks it twice (#1483). First unlocked, before it reads
 * anything. Then `share`, just before the earlier messages: the row is held
 * for share until the transaction ends, so the owner cannot change between
 * that check and the read, and a change committed first is refused. The
 * page task is locked before it, as a purge locks the task before the
 * conversation, and a read the page already refuses never takes it, so a
 * read never waits behind a purge's uncommitted update.
 */
export async function ownsAsked(
  tx: TenantQuery,
  session: Session,
  asked: Asked,
  lock: 'none' | 'share' = 'none',
): Promise<boolean> {
  if (!isUuid(asked.conversationId) || !isUuid(asked.messageId)) return false;
  const rows = await tx.query(
    `select c.id from conversations c
       join conversation_messages m on m.business_id = c.business_id and m.conversation_id = c.id
      where c.business_id = $1 and c.id = $2 and m.id = $3
        and c.owner_actor_id = $4 and c.body_purged_at is null
      ${lock === 'share' ? 'for share of c' : ''}`,
    [tx.businessId, asked.conversationId, asked.messageId, session.actorId],
  );
  return rows.length > 0;
}
