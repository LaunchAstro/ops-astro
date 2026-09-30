// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-03's exchange: the agent's answer to a person's message.
//
// The person's message is kept by its own command (`conversation.start` or
// `conversation.message`), which commits first. Then, on the person path
// only, the API hands the kept message here:
//
// 1. The caller is resolved again from the verified session, and the message
//    is found as the caller's own, a person's message, in a conversation of
//    this business whose body is kept. Anything else answers nothing.
// 2. Its words go to AW-01's broker on the conversation seam
//    (`callModelInConversation`): the owner in their own session, a local
//    route only, nothing held. A cloud route is refused there before anything
//    is written or sent (AW-03 egress off).
// 3. The answer is kept as the agent's message answering that one message
//    (0221), in a second transaction that resolves the caller again and takes
//    the conversation's row lock, as a message and the purge do, so a reply
//    never lands in a body being purged.
//
// A message has at most one reply. A repeat of the request finds the reply
// kept and answers with it, and the model is not asked again; two repeats at
// once can each ask it, and only the first answer is kept. The model's words
// are kept in the reply's row and nowhere else: a refusal answers in fixed
// words, never the model's or the person's.

import { randomUUID } from 'node:crypto';
import { CONVERSATION_ANSWER } from '../../../core-connectors/src/index.ts';
import {
  callModelInConversation,
  type ConversationScope,
} from '../../../core-custody/src/index.ts';
import { isUuid, withSession } from '../../../core-records/src/index.ts';
import type {
  BusinessId,
  Database,
  Session,
  TenantQuery,
  VerifiedSubject,
} from '../../../core-records/src/index.ts';
import { bounded } from './conversations.ts';
import { auditAs, type ModelBroker } from './model-call.ts';
import { isCommandRefusal } from './refusal.ts';

/** What the person path hands back beside an applied message: the answer, or why none. */
export type ConversationReply =
  | { readonly answered: true; readonly messageId: string; readonly body: string }
  | { readonly answered: false; readonly code: string; readonly words: string };

/** The message a person just kept, from the applied command's detail. */
export interface Asked {
  readonly conversationId: string;
  readonly messageId: string;
}

export type ConversationExchange = (
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  asked: Asked,
) => Promise<ConversationReply | null>;

/** A reply's body is a message's (0198). */
const REPLY_LIMIT = 20_000;

const OFF =
  'Models are off for this material until a local model is available, so nothing was sent. ' +
  'Your message is kept.';

const WORDS: Readonly<Record<string, string>> = {
  LOCAL_MODEL_REQUIRED: OFF,
  CLIENT_MODEL_USE_OFF: OFF,
  RATE_LIMITED: 'The model is busy, so nothing was sent. Your message is kept; ask again shortly.',
};

const UNUSABLE =
  'The model’s answer could not be used, so nothing was kept. Your message is kept; ask again.';

const refusedWith = (code: string): ConversationReply => ({
  answered: false,
  code,
  words: WORDS[code] ?? UNUSABLE,
});

interface Kept {
  readonly id: string;
  readonly body: string;
}

const answered = (reply: Kept): ConversationReply => ({
  answered: true,
  messageId: reply.id,
  body: reply.body,
});

interface Question {
  readonly scope: ConversationScope;
  readonly body: string;
  readonly reply: Kept | undefined;
}

/** The kept reply to a message, if there is one. */
async function replyTo(tx: TenantQuery, asked: Asked): Promise<Kept | undefined> {
  const [reply] = await tx.query<Kept>(
    `select id, body from conversation_messages
      where business_id = $1 and conversation_id = $2 and answers_message_id = $3`,
    [tx.businessId, asked.conversationId, asked.messageId],
  );
  return reply;
}

/** The caller's own person message, in a conversation of this business whose body is kept. */
async function questionOf(
  tx: TenantQuery,
  session: Session,
  asked: Asked,
): Promise<Question | undefined> {
  if (!isUuid(asked.conversationId) || !isUuid(asked.messageId)) return undefined;
  const [found] = await tx.query<{ readonly owner_person_id: string; readonly body: string }>(
    `select c.owner_person_id, m.body
       from conversations c
       join conversation_messages m on m.business_id = c.business_id and m.conversation_id = c.id
      where c.business_id = $1 and c.id = $2 and m.id = $3 and m.role = 'person'
        and c.owner_actor_id = $4 and c.body_purged_at is null`,
    [tx.businessId, asked.conversationId, asked.messageId, session.actorId],
  );
  if (found === undefined) return undefined;
  return {
    scope: {
      id: asked.conversationId,
      businessId: tx.businessId,
      ownerPersonId: found.owner_person_id,
    },
    body: found.body,
    reply: await replyTo(tx, asked),
  };
}

/** The answer, kept as the reply to the message, or the reply already kept. */
async function keep(
  tx: TenantQuery,
  session: Session,
  asked: Asked,
  body: string,
): Promise<Kept | undefined> {
  const [conversation] = await tx.query<{ readonly body_purged_at: Date | null }>(
    `select body_purged_at from conversations
      where business_id = $1 and id = $2 and owner_actor_id = $3
      for update`,
    [tx.businessId, asked.conversationId, session.actorId],
  );
  if (conversation === undefined || conversation.body_purged_at !== null) return undefined;
  const id = randomUUID();
  const inserted = await tx.query(
    `insert into conversation_messages
       (business_id, id, conversation_id, role, author_actor_id, body, answers_message_id)
     values ($1, $2, $3, 'agent', $4, $5, $6)
     on conflict (business_id, conversation_id, answers_message_id)
       where answers_message_id is not null
     do nothing
     returning id`,
    [tx.businessId, id, asked.conversationId, session.actorId, body, asked.messageId],
  );
  if (inserted.length === 0) return await replyTo(tx, asked);
  await tx.query(
    `update conversations set last_activity_at = greatest(now(), last_activity_at)
      where business_id = $1 and id = $2`,
    [tx.businessId, asked.conversationId],
  );
  return { id, body };
}

/** The exchange over a deployment's broker, for the API's person path. */
export function conversationExchange(broker: ModelBroker): ConversationExchange {
  return async (database, businessId, presented, asked) => {
    const found = await withSession(database, businessId, presented, async (tx, session) => ({
      session,
      question: await questionOf(tx, session, asked),
    }));
    if (isCommandRefusal(found) || found.question === undefined) return null;
    const { session, question } = found;
    if (question.reply !== undefined) return answered(question.reply);
    const result = await callModelInConversation(
      database,
      businessId,
      { actorId: session.actorId, delegationId: null, attendedByPersonId: session.personId },
      {
        conversation: question.scope,
        operation: CONVERSATION_ANSWER.key,
        fields: [{ name: 'message', source: 'outside', value: question.body }],
      },
      { ...broker, audit: auditAs(session.actorId) },
    );
    if (!result.ok) return refusedWith(result.code);
    if (!bounded(result.text, REPLY_LIMIT)) return refusedWith('ANSWER_UNUSABLE');
    const kept = await withSession(
      database,
      businessId,
      presented,
      async (tx, now) => await keep(tx, now, asked, result.text),
    );
    return kept === undefined || isCommandRefusal(kept) ? null : answered(kept);
  };
}
