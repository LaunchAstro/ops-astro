// SPDX-License-Identifier: AGPL-3.0-only
//
// The exchange's keep (`conversation-exchange.ts`): the answer kept as the
// reply to its message, with the snapshot its question read (#1666), or the
// reply a twin kept first, with that one's; and the kept reply read back, its
// targets as the caller may have them (`conversation-targets.ts`).

import { randomUUID } from 'node:crypto';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import { hearingAt, type Asked } from './conversation-pieces.ts';
import type { Kept } from './conversation-replies.ts';
import { keepSnapshot, targetsFor, type Snapshot } from './conversation-targets.ts';

/** The kept reply to a message, if there is one, with its kept targets as the caller may have them. */
export async function replyTo(
  tx: TenantQuery,
  session: Session,
  asked: Asked,
): Promise<Kept | undefined> {
  const [reply] = await tx.query<Kept>(
    `select id, body from conversation_messages
      where business_id = $1 and conversation_id = $2 and answers_message_id = $3`,
    [tx.businessId, asked.conversationId, asked.messageId],
  );
  if (reply === undefined) return undefined;
  const targets = (await targetsFor(tx, session, [reply.id])).get(reply.id);
  return targets === undefined ? reply : { ...reply, targets };
}

/**
 * The answer, kept as the reply to the message with its snapshot, or the
 * reply already kept, with that one's: a twin's snapshot is never replaced.
 */
export async function keep(
  tx: TenantQuery,
  session: Session,
  asked: Asked,
  body: string,
  snapshot: Snapshot | null,
): Promise<Kept | undefined> {
  // The conversation's row locked, the session asked, then the grants held
  // for share and judged at the clock after the locks (`hearingAt`): a
  // revocation that committed first is seen, and one that comes later waits
  // for this reply to commit.
  const at = await hearingAt(tx, session, asked, 'update');
  if (at === undefined) return undefined;
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
  if (inserted.length === 0) return await replyTo(tx, session, asked);
  if (snapshot !== null) await keepSnapshot(tx, id, snapshot);
  await activeAt(tx, asked.conversationId, at);
  return await replyTo(tx, session, asked);
}

/** The conversation's last activity moved up to `at`, never back. */
async function activeAt(tx: TenantQuery, conversationId: string, at: string): Promise<void> {
  await tx.query(
    `update conversations set last_activity_at = greatest($3::text::timestamptz, last_activity_at)
      where business_id = $1 and id = $2`,
    [tx.businessId, conversationId, at],
  );
}
