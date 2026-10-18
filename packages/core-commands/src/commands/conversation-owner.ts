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
 * `contextOf` asks it before it reads anything (#1483). It takes no lock: the
 * application role may change a conversation's owner (0092), so the earlier
 * messages are read in a statement that asks the owner again itself, and a
 * session that no longer owns the conversation at that instant reads none.
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

/**
 * The last earlier messages before the asked one, each person's with its
 * answer, oldest first; only those of the conversation's current context
 * epoch, which a purge of the task it was opened on bumps under the row lock
 * every message write takes. A reply counts only when its question does too,
 * so one kept after the purge to a question from before it is cut with it.
 * The statement asks the owner itself, so the rows are the session's own at
 * the one instant it reads them (#1483).
 */
export interface EarlierRow {
  readonly role: string;
  readonly body: string;
  readonly author: string;
}

export async function earlierRows(
  tx: TenantQuery,
  session: Session,
  asked: Asked,
  count: number,
): Promise<readonly EarlierRow[]> {
  return await tx.query<EarlierRow>(
    `select role, body, author from (
       select m.role, m.body, m.created_at, m.id, m.author_actor_id::text as author
         from conversation_messages m
         join conversation_messages a
           on a.business_id = m.business_id and a.conversation_id = m.conversation_id
         join conversations c on c.business_id = m.business_id and c.id = m.conversation_id
         left join conversation_messages q
           on q.business_id = m.business_id and q.id = m.answers_message_id
        where m.business_id = $1 and m.conversation_id = $2 and a.id = $3
          and m.role in ('person', 'agent') and m.created_at < a.created_at
          and c.owner_actor_id = $5 and c.body_purged_at is null
          and m.context_epoch = c.context_epoch
          and coalesce(q.context_epoch, m.context_epoch) = c.context_epoch
          and (m.role = 'agent' or exists (
            select 1 from conversation_messages r
             where r.business_id = m.business_id and r.conversation_id = m.conversation_id
               and r.answers_message_id = m.id))
        order by m.created_at desc, m.id desc
        limit $4) last
      order by created_at, id`,
    [tx.businessId, asked.conversationId, asked.messageId, count, session.actorId],
  );
}
