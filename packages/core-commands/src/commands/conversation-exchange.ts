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
//    nothing, a reply already kept included.
// 2. Its words go to AW-01's broker on the conversation seam
//    (`callModelInConversation`): the owner in their own session, a local
//    route only, nothing held. A cloud route is refused there before anything
//    is written or sent (AW-03 egress off). It asks for the conversation's
//    model (CS-7.30), the default when none is chosen; a chosen model no
//    longer offered it (`offeredModels`) is refused first, nothing sent.
// 3. The answer is kept as the agent's message answering that one message
//    (0099), in a second transaction that resolves the caller again, takes
//    the conversation's row lock, as a message and the purge do, so a reply
//    never lands in a body being purged, and asks the grant again under it,
//    with the grants held for share and judged at the clock after the locks;
//    a grant being changed at that moment keeps nothing.
//
// A message has at most one reply. A repeat of the request finds the reply
// kept and answers with it, and the model is not asked again; a repeat while
// the answer is with the model, in the same process, waits for it. The model's words
// are kept in the reply's row and nowhere else: a refusal answers in fixed
// words, never the model's or the person's.

import { randomUUID } from 'node:crypto';
import { CONVERSATION_ANSWER } from '../../../core-connectors/src/index.ts';
import {
  callModelInConversation,
  type ConversationScope,
} from '../../../core-custody/src/index.ts';
import {
  checkAuthority,
  isUuid,
  sessionEndedSince,
  slotOf,
  subjectsOf,
  TASK_SPINE,
  withSession,
} from '../../../core-records/src/index.ts';
import type {
  BusinessId,
  Database,
  Session,
  TenantQuery,
  VerifiedSubject,
} from '../../../core-records/src/index.ts';
import { holdCoveringGrants, lockedInstant } from '../../../core-runtime/src/index.ts';
import { bounded, holdsOwnConversations } from './conversations.ts';
import { askedModel } from './conversation-model.ts';
import {
  answered,
  refusedWith,
  type ConversationReply,
  type Kept,
} from './conversation-replies.ts';
import { auditAs, type ModelBroker } from './model-call.ts';
import { isCommandRefusal } from './refusal.ts';

export type { ConversationReply } from './conversation-replies.ts';

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

/** A reply's body is a message's (0092). */
const REPLY_LIMIT = 20_000;

interface Question {
  readonly scope: ConversationScope;
  readonly body: string;
  readonly reply: Kept | undefined;
  /** The conversation was opened on a task with a client, or on one this session cannot see. */
  readonly clientOrUnseen: boolean;
  /** The model to ask (CS-7.30): the chosen one, else the default; null when the choice is not offered now. */
  readonly model: string | undefined | null;
}

const CLIENT = slotOf(TASK_SPINE, 'client');

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
    readonly client_or_unseen: boolean;
  }>(
    `select c.owner_person_id, m.body, c.scope_record_id,
            (t.${CLIENT} is not null or (c.scope_record_id is not null and t.id is null))
              as client_or_unseen
       from conversations c
       join conversation_messages m on m.business_id = c.business_id and m.conversation_id = c.id
       left join records t on t.business_id = c.business_id and t.id = c.scope_record_id
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
    clientOrUnseen:
      found.client_or_unseen || !(await readsTask(tx, session, found.scope_record_id)),
  };
}

/** The caller may still read the task: the records policies do not hold task grants. */
async function readsTask(tx: TenantQuery, session: Session, id: string | null): Promise<boolean> {
  if (id === null) return true;
  const read = { collection: 'task', action: 'read', scope: { kind: 'record', id } } as const;
  return (await checkAuthority(tx, subjectsOf(session), read)).ok;
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
  // An ended session keeps nothing, and an ending in flight waits for this; asked
  // before the grants, so the grant is judged at the clock after this wait too.
  if (await sessionEndedSince(tx, session)) return undefined;
  // The caller's conversation grants are held for share once the row is
  // locked, a grant issued while this waited included: a revocation that
  // committed first is seen by the check below, and one that comes later waits
  // for this reply to commit. `nowait`, because the trash purge locks grants
  // before conversations: one being changed now rolls the reply back
  // (`heldElsewhere`). The check is asked at the clock after the locks, so a
  // grant that lapsed while this waited no longer counts, and must rest on a
  // grant held here, so one issued after the hold does not.
  const held = new Set(await holdCoveringGrants(tx, subjectsOf(session), 'conversation', 'nowait'));
  const at = await lockedInstant(tx);
  if (!(await holdsOwnConversations(tx, session, { at, held }))) return undefined;
  const id = randomUUID();
  // The reply and the activity are stamped at that same instant, so a reply
  // that waited behind a message is listed and dated after it (#444). The
  // instant goes in as text: a timestamptz parameter keeps milliseconds only.
  const inserted = await tx.query(
    `insert into conversation_messages
       (business_id, id, conversation_id, role, author_actor_id, body, answers_message_id,
        created_at)
     values ($1, $2, $3, 'agent', $4, $5, $6, $7::text::timestamptz)
     on conflict (business_id, conversation_id, answers_message_id)
       where answers_message_id is not null
     do nothing
     returning id`,
    [tx.businessId, id, asked.conversationId, session.actorId, body, asked.messageId, at],
  );
  if (inserted.length === 0) return await replyTo(tx, asked);
  await tx.query(
    `update conversations set last_activity_at = greatest($3::text::timestamptz, last_activity_at)
      where business_id = $1 and id = $2`,
    [tx.businessId, asked.conversationId, at],
  );
  return { id, body };
}

/** A grant being changed under the reply's `nowait` hold: the reply rolled back, nothing kept. */
function heldElsewhere(cause: unknown): undefined {
  if ((cause as { readonly code?: unknown }).code !== '55P03') throw cause;
  return undefined;
}

/** The model asked for one message, and the answer kept as its reply. */
async function answerOnce(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  asked: Asked,
  found: { readonly session: Session; readonly question: Question },
  broker: ModelBroker,
): Promise<ConversationReply | null> {
  const { session, question } = found;
  // A read that came back after an earlier answer was kept and its flight ended: read again.
  const earlier = await withSession(database, businessId, presented, (tx) => replyTo(tx, asked));
  if (earlier !== undefined) return isCommandRefusal(earlier) ? null : answered(earlier);
  const result = await callModelInConversation(
    database,
    businessId,
    { actorId: session.actorId, delegationId: null, attendedByPersonId: session.personId },
    {
      conversation: question.scope,
      operation: CONVERSATION_ANSWER.key,
      fields: [{ name: 'message', source: 'outside', value: question.body }],
      ...(question.model === undefined || question.model === null ? {} : { model: question.model }),
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
  ).catch(heldElsewhere);
  return kept === undefined || isCommandRefusal(kept) ? null : answered(kept);
}

/**
 * The exchange over a deployment's broker, for the API's person path. A request whose
 * own message is already with the model (in this process) waits for that answer: a
 * retry asking again would spend tokens on a reply that is not kept.
 */
export function conversationExchange(broker: ModelBroker): ConversationExchange {
  const asking = new Map<string, Promise<ConversationReply | null>>();
  return async (database, businessId, presented, asked) => {
    // The provider the deployment's broker runs the conversation on: what it can send.
    const provider = broker.operations.get(CONVERSATION_ANSWER.key)?.provider ?? '';
    const found = await withSession(database, businessId, presented, async (tx, session) => ({
      session,
      question: await questionOf(tx, session, asked, provider),
    }));
    if (isCommandRefusal(found) || found.question === undefined) return null;
    const { question } = found;
    if (question.reply !== undefined) return answered(question.reply);
    if (question.model === null) return refusedWith('MODEL_NOT_OFFERED');
    // Owner line 72: a client's material reaches no model (the laptop's GPT is a cloud
    // model); nor does a task this session cannot see, whose client cannot be known.
    if (question.clientOrUnseen) return refusedWith('CLIENT_MODEL_USE_OFF');
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
    ).finally(() => asking.delete(key));
    asking.set(key, answering);
    return await answering;
  };
}
