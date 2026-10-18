// SPDX-License-Identifier: AGPL-3.0-only
//
// The exchange's reply keep (`conversation-exchange.ts`): the answer kept as
// the agent's message answering one person message (0099), under the
// conversation's row lock, and a reply whose keep failed kept once from its
// settled call's answer copy (#1563). Apart from the exchange for its line cap.
//
// A message's call settles in custody's transaction, which copies the answer
// (`copyAnswer`); the reply is kept in a second transaction. If that keep
// rolls back or its process dies, the message has a settled call and no
// reply, and asking the model again would be a second charge. Instead a
// retry, from any process, keeps the reply from the copy: by the same `keep`,
// under the same lock and checks, so whichever keep takes the conversation's
// row first keeps the reply and the other finds it. A kept reply deletes the
// copy in the same transaction, so the model's words are at rest in the reply
// alone once it is kept.

import { randomUUID } from 'node:crypto';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import { hearingAt, type Asked } from './conversation-pieces.ts';
import { usableReply } from './conversation-paid.ts';
import type { Kept } from './conversation-replies.ts';

/** The kept reply to a message, if there is one. */
export async function replyTo(tx: TenantQuery, asked: Asked): Promise<Kept | undefined> {
  const [reply] = await tx.query<Kept>(
    `select id, body from conversation_messages
      where business_id = $1 and conversation_id = $2 and answers_message_id = $3`,
    [tx.businessId, asked.conversationId, asked.messageId],
  );
  return reply;
}

/** The answer, kept as the reply to the message, or the reply already kept; its copy goes. */
export async function keep(
  tx: TenantQuery,
  session: Session,
  asked: Asked,
  body: string,
): Promise<Kept | undefined> {
  // The conversation's row locked, the session asked, then the grants held
  // for share and judged at the clock after the locks (`hearingAt`): a
  // revocation that committed first is seen, and one that comes later waits
  // for this reply to commit.
  const at = await hearingAt(tx, session, asked, 'update');
  if (at === undefined) return undefined;
  // The message has its reply once this commits, so the answer's copy is spent.
  await tx.query(
    `delete from conversation_answer_copies where business_id = $1 and message_id = $2`,
    [tx.businessId, asked.messageId],
  );
  const id = randomUUID();
  // The reply and the activity are stamped at that same instant, so a reply
  // that waited behind a message is listed and dated after it (#444). The
  // instant goes in as text: a timestamptz parameter keeps milliseconds only.
  const inserted = await tx.query(
    `insert into conversation_messages
       (business_id, id, conversation_id, role, author_actor_id, body, answers_message_id,
        created_at, context_epoch)
     values ($1, $2, $3, 'agent', $4, $5, $6, $7::text::timestamptz,
             (select context_epoch from conversations where business_id = $1 and id = $3))
     on conflict (business_id, conversation_id, answers_message_id)
       where answers_message_id is not null
     do nothing
     returning id`,
    [tx.businessId, id, asked.conversationId, session.actorId, body, asked.messageId, at],
  );
  if (inserted.length === 0) return await replyTo(tx, asked);
  await activeAt(tx, asked.conversationId, at);
  return { id, body };
}

/** The conversation's last activity moved up to `at`, never back. */
async function activeAt(tx: TenantQuery, conversationId: string, at: string): Promise<void> {
  await tx.query(
    `update conversations set last_activity_at = greatest($3::text::timestamptz, last_activity_at)
      where business_id = $1 and id = $2`,
    [tx.businessId, conversationId, at],
  );
}

/**
 * The message's reply, read in the caller's session: the one kept, or one
 * kept now by `keep` from its settled call's answer copy, which no model is
 * asked for. The copy is read in the message's own conversation, and `keep`
 * judges the caller under the lock as it judges any reply.
 */
export const keptReply =
  (asked: Asked) =>
  async (tx: TenantQuery, session: Session): Promise<Kept | undefined> => {
    const reply = await replyTo(tx, asked);
    if (reply !== undefined) return reply;
    const [copy] = await tx.query<{ readonly body: string }>(
      `select a.body from conversation_answer_copies a
         join conversation_messages m on m.business_id = a.business_id and m.id = a.message_id
        where a.business_id = $1 and a.message_id = $2 and m.conversation_id = $3`,
      [tx.businessId, asked.messageId, asked.conversationId],
    );
    if (copy === undefined || !usableReply(copy.body)) return undefined;
    return await keep(tx, session, asked, copy.body);
  };
