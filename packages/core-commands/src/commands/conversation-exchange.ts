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
//    (`conversation-context.ts`).
// 2. Its words, with the page's id and title and the earlier messages, go to
//    AW-01's broker on the conversation seam
//    (`callModelInConversation`): the owner in their own session, a local
//    route only, nothing held. A cloud route is refused there before anything
//    is written or sent (AW-03 egress off).
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
  isUuid,
  sessionEndedSince,
  subjectsOf,
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
import { contextOf, type Cite, type Context } from './conversation-context.ts';
import { bounded, holdsOwnConversations } from './conversations.ts';
import { auditAs, type ModelBroker } from './model-call.ts';
import { isCommandRefusal } from './refusal.ts';

/** What the person path hands back beside an applied message: the answer, or why none. */
export type ConversationReply =
  | {
      readonly answered: true;
      readonly messageId: string;
      readonly body: string;
      /** The records the call read, by the product's own address. */
      readonly cites: readonly Cite[];
    }
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

/** A reply's body is a message's (0092). */
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

const answered = (reply: Kept, cites: readonly Cite[]): ConversationReply => ({
  answered: true,
  messageId: reply.id,
  body: reply.body,
  cites,
});

interface Question {
  readonly scope: ConversationScope;
  readonly body: string;
  readonly reply: Kept | undefined;
  /** What goes beside the message, and whether the page refuses any model. */
  readonly context: Context;
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
    scope: {
      id: asked.conversationId,
      businessId: tx.businessId,
      ownerPersonId: found.owner_person_id,
    },
    body: found.body,
    reply: await replyTo(tx, asked),
    context: await contextOf(tx, session, asked, found.scope_record_id),
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
  // After the last wait: an ended session keeps nothing; an ending in flight waits for this.
  if (await sessionEndedSince(tx, session)) return undefined;
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
  const result = await callModelInConversation(
    database,
    businessId,
    { actorId: session.actorId, delegationId: null, attendedByPersonId: session.personId },
    {
      conversation: question.scope,
      operation: CONVERSATION_ANSWER.key,
      fields: [
        ...question.context.fields.map((field) => ({ ...field, source: 'outside' as const })),
        { name: 'message', source: 'outside', value: question.body },
      ],
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
  return async (database, businessId, presented, asked) => {
    const found = await withSession(database, businessId, presented, async (tx, session) => ({
      session,
      question: await questionOf(tx, session, asked),
    }));
    if (isCommandRefusal(found) || found.question === undefined) return null;
    const { question } = found;
    // A repeat finds the reply kept and makes no call, so it read nothing and cites nothing.
    if (question.reply !== undefined) return answered(question.reply, []);
    // Owner line 72: a client's material reaches no model while no true local
    // model exists, and the laptop's GPT runner is a cloud model. A conversation
    // opened on a client's task asks nothing, whatever the provider; so does one whose
    // task this session cannot see, since its client cannot be known.
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
    ).finally(() => asking.delete(key));
    asking.set(key, answering);
    return await answering;
  };
}
