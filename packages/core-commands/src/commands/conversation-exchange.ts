// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-03's exchange: the agent's answer to a person's message.
//
// The person's message is kept by its own command (`conversation.start` or
// `conversation.message`), which commits first. Then, on the person path
// only, the API hands the kept message here:
//
// 1. The caller is resolved again from the verified session, still holds
//    `conversation:write` as `conversation.read` asks of an owner, and the
//    message is found as the caller's own, a person's message, in a
//    conversation of this business whose body is kept. Anything else answers
//    nothing, a reply already kept included. In the same transaction the
//    conversation's page task is held for share and checked (no client, in
//    the caller's grants), and the bounded earlier messages are read
//    (`conversation-context.ts`); a message once refused there stays refused.
// 2. Its words, with the page's id and title and the earlier messages, go to
//    AW-01's broker on the conversation seam
//    (`callModelInConversation`): the owner in their own session, a local
//    route only, nothing held. A cloud route is refused there before anything
//    is written or sent (AW-03 egress off). It asks for the conversation's
//    model (CS-7.30), the default when none is chosen; a chosen model no
//    longer offered it (`offeredModels`) is refused first, nothing sent. Where
//    the caller takes pieces, the answer's display text goes to it as the
//    model writes it, each batch only under the authority the reply is kept
//    under (`conversation-pieces.ts`); it is provisional, and only the settled
//    answer is kept.
// 3. The answer is kept as the agent's message answering that one message
//    (0099), in a second transaction that resolves the caller again, takes
//    the conversation's row lock, as a message and the purge do, so a reply
//    never lands in a body being purged, and asks the grant again under it,
//    with the grants held for share and judged at the clock after the locks;
//    a grant being changed at that moment keeps nothing.
//
// A message has at most one reply, and at most one model call, whichever
// process asks (#1531). A repeat of the request finds the reply kept and
// answers with it, and the model is not asked again; a repeat while the answer
// is with the model, in the same process, waits for it; in another process it
// is told the answer is on its way, and after a call that kept no reply, that
// the answer ended and the message is to be sent again. The model's words
// are kept in the reply's row and nowhere else: a refusal answers in fixed
// words, never the model's or the person's. Words the store cannot hold as
// sent (a NUL, half a split character) are refused as unusable, never a fault.

import { randomUUID } from 'node:crypto';
import { CONVERSATION_ANSWER } from '../../../core-connectors/src/index.ts';
import {
  callModelInConversation,
  type ConversationCallRequest,
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
import { carriedBy } from './carriage-origin.ts';
import { contextOf, type Context } from './conversation-context.ts';
import { hearingAt, heldElsewhere, judgedPieces, type Asked } from './conversation-pieces.ts';
import { bounded, holdsOwnConversations } from './conversations.ts';
import { askedModel } from './conversation-model.ts';
import {
  answered,
  refusedWith,
  releasedWith,
  type ConversationReply,
  type Kept,
} from './conversation-replies.ts';
import { auditAs, type ModelBroker } from './model-call.ts';
import { isCommandRefusal } from './refusal.ts';
import { storableText } from './values.ts';

export type { ConversationReply } from './conversation-replies.ts';

export type { Asked } from './conversation-pieces.ts';

export type ConversationExchange = (
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  asked: Asked,
  /** Where the answer's display text goes as it is written; only the settled reply is kept. */
  onPiece?: (text: string) => void,
  /** The person's own access token, for a carried call's line (live chat route B); absent, none is carried. */
  accessToken?: string,
) => Promise<ConversationReply | null>;

/** A reply's body is a message's (0092). */
const REPLY_LIMIT = 20_000;

interface Question {
  readonly scope: ConversationScope;
  readonly body: string;
  readonly reply: Kept | undefined;
  /** What goes beside the message, and whether the page refuses any model. */
  readonly context: Context;
  /** The model to ask (CS-7.30): the chosen one, else the default; null when the choice is not offered now. */
  readonly model: string | undefined | null;
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
  provider: string,
): Promise<Question | undefined> {
  if (!isUuid(asked.conversationId) || !isUuid(asked.messageId)) return undefined;
  if (!(await holdsOwnConversations(tx, session))) return undefined;
  const [found] = await tx.query<{
    readonly owner_person_id: string;
    readonly body: string;
    readonly scope_record_id: string | null;
  }>(
    `select c.owner_person_id, m.body, c.scope_record_id
       from conversations c
       join conversation_messages m on m.business_id = c.business_id and m.conversation_id = c.id
      where c.business_id = $1 and c.id = $2 and m.id = $3 and m.role = 'person'
        and c.owner_actor_id = $4 and c.body_purged_at is null`,
    [tx.businessId, asked.conversationId, asked.messageId, session.actorId],
  );
  if (found === undefined) return undefined;
  return {
    model: await askedModel(tx, session, asked.conversationId, provider),
    scope: {
      id: asked.conversationId,
      businessId: tx.businessId,
      ownerPersonId: found.owner_person_id,
    },
    body: found.body,
    reply: await replyTo(tx, asked),
    context: await contextOf(tx, session, { ...asked, body: found.body }, found.scope_record_id),
  };
}

/** The answer, kept as the reply to the message, or the reply already kept. */
async function keep(
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

/** The conversation seam's request for the question: its words and context, its model, and how it is heard. */
function requestFor(
  question: Question,
  asked: Asked,
  heard: Pick<ConversationCallRequest, 'onPiece' | 'carry'>,
): ConversationCallRequest {
  return {
    conversation: question.scope,
    messageId: asked.messageId,
    operation: CONVERSATION_ANSWER.key,
    fields: [
      ...question.context.fields.map((field) => ({ ...field, source: 'outside' as const })),
      { name: 'message', source: 'outside', value: question.body },
    ],
    ...(question.model === undefined || question.model === null ? {} : { model: question.model }),
    ...heard,
  };
}

/** The model asked for one message, and the answer kept as its reply. */
async function answerOnce(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  asked: Asked,
  found: { readonly session: Session; readonly question: Question },
  broker: ModelBroker,
  by: { readonly onPiece?: (text: string) => void; readonly accessToken?: string },
): Promise<ConversationReply | null> {
  const { session, question } = found;
  // Pieces reach the caller only while they may hear the answer, judged as the reply is.
  const pieces = by.onPiece && judgedPieces(database, businessId, presented, asked, by.onPiece);
  // A read that came back after an earlier answer was kept and its flight ended: read again.
  const earlier = await withSession(database, businessId, presented, (tx) => replyTo(tx, asked));
  if (earlier !== undefined) return isCommandRefusal(earlier) ? null : answered(earlier, []);
  const result = await callModelInConversation(
    database,
    businessId,
    { actorId: session.actorId, delegationId: null, attendedByPersonId: session.personId },
    requestFor(question, asked, {
      ...(pieces === undefined ? {} : { onPiece: pieces.push }),
      ...carriedBy(database, businessId, presented, by.accessToken, broker),
    }),
    { ...broker, audit: auditAs(session.actorId) },
  );
  await pieces?.drained();
  if (!result.ok) {
    return result.code === 'CALL_RELEASED' ? releasedWith(result.reason) : refusedWith(result.code);
  }
  // A model's words pass no command's door: what a message may not hold, a reply may not either.
  if (!bounded(result.text, REPLY_LIMIT) || !storableText(result.text)) {
    return refusedWith('ANSWER_UNUSABLE');
  }
  const kept = await withSession(
    database,
    businessId,
    presented,
    async (tx, now) => await keep(tx, now, asked, result.text),
  ).catch(heldElsewhere);
  if (kept === undefined || isCommandRefusal(kept)) return null;
  // The cites are what this call read, even where a twin request's answer was kept first.
  return answered(kept, question.context.cites);
}

/**
 * The exchange over a deployment's broker, for the API's person path. A request whose
 * own message is already with the model (in this process) waits for that answer: a
 * retry asking again would spend tokens on a reply that is not kept.
 */
export function conversationExchange(broker: ModelBroker): ConversationExchange {
  const asking = new Map<string, Promise<ConversationReply | null>>();
  return async (database, businessId, presented, asked, onPiece, accessToken) => {
    // The provider the deployment's broker runs the conversation on: what it can send.
    const provider = broker.operations.get(CONVERSATION_ANSWER.key)?.provider ?? '';
    const found = await withSession(database, businessId, presented, async (tx, session) => ({
      session,
      question: await questionOf(tx, session, asked, provider),
    }));
    if (isCommandRefusal(found) || found.question === undefined) return null;
    const { question } = found;
    // A repeat finds the reply kept and makes no call, so it read nothing and cites nothing.
    if (question.reply !== undefined) return answered(question.reply, []);
    if (question.model === null) return refusedWith('MODEL_NOT_OFFERED');
    // Owner line 72: a client's material reaches no model (the laptop's GPT is a cloud
    // model); nor does a task this session cannot see, whose client cannot be known.
    if (question.context.refused) return refusedWith('CLIENT_MODEL_USE_OFF');
    const key = `${businessId}/${asked.conversationId}/${asked.messageId}`;
    const running = asking.get(key);
    if (running !== undefined) return await running;
    const answering = answerOnce(
      database,
      businessId,
      presented,
      asked,
      { ...found, question },
      broker,
      {
        ...(onPiece === undefined ? {} : { onPiece }),
        ...(accessToken === undefined ? {} : { accessToken }),
      },
    ).finally(() => asking.delete(key));
    asking.set(key, answering);
    return await answering;
  };
}
