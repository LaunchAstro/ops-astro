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
 * Whether the session owns the asked message's conversation, its body kept:
 * `contextOf` asks it before it reads anything (#1483). The owner is written
 * once and never changed, so this takes no row lock, which there would come
 * before the page task's, the reverse of a purge's order.
 */
export async function ownsAsked(tx: TenantQuery, session: Session, asked: Asked): Promise<boolean> {
  if (!isUuid(asked.conversationId) || !isUuid(asked.messageId)) return false;
  const [row] = await tx.query<{ readonly owns: boolean }>(
    `select exists (
       select 1 from conversations c
         join conversation_messages m on m.business_id = c.business_id and m.conversation_id = c.id
        where c.business_id = $1 and c.id = $2 and m.id = $3
          and c.owner_actor_id = $4 and c.body_purged_at is null) as owns`,
    [tx.businessId, asked.conversationId, asked.messageId, session.actorId],
  );
  return row?.owns === true;
}
