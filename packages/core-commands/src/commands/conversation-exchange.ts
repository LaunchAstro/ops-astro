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
//    is written or sent (AW-03 egress off), save the owner's ChatGPT plan for
//    his own typed message (#2175, P4): the request names who wrote each turn
//    sent, the page and the earlier exchanges' tasks, and the broker judges
//    them again under its locks. It asks for the conversation's
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

import {
  CONVERSATION_ANSWER,
  OPENROUTER_CONVERSATION_KEY,
} from '../../../core-connectors/src/index.ts';
import {
  callModelInConversation,
  type ConversationScope,
} from '../../../core-custody/src/index.ts';
import { isUuid, subjectsOf, withSession } from '../../../core-records/src/index.ts';
import type {
  BusinessId,
  Database,
  Session,
  Subject,
  TenantQuery,
  VerifiedSubject,
} from '../../../core-records/src/index.ts';
import { carriedBy } from './carriage-handoff.ts';
import { contextOf, type Context } from './conversation-context.ts';
import { pageTaskOf } from './conversation-page-task.ts';
import { heldElsewhere, judgedPieces, type Asked } from './conversation-pieces.ts';
import { operationFor, paidSeams, unanswered, usableReply } from './conversation-paid.ts';
import { holdsOwnConversations } from './conversations.ts';
import { requestFor } from './conversation-request.ts';
import { keep, replyTo } from './conversation-keep.ts';
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

interface Question {
  readonly scope: ConversationScope;
  readonly body: string;
  readonly reply: Kept | undefined;
  /** What goes beside the message, and whether the page refuses any model. */
  readonly context: Context;
  /** The model to ask (CS-7.30): the chosen one, else the default; null when the choice is not offered now. */
  readonly model: string | undefined | null;
  /** The install's conversation provider, which an id two providers share is first read against. */
  readonly provider: string;
  /** The page task the conversation is on, as read with the context. */
  readonly page: string | null;
  /** Who wrote the asked message and each earlier person turn read. */
  readonly authors: readonly string[];
  /** The tasks the earlier exchanges sent may carry (#1666): judged again at a handoff. */
  readonly sources: readonly string[];
  /** The caller's subjects, whose grants the context was read under: a plan call's are asked again. */
  readonly subjects: readonly Subject[];
  /** The answer kept as the reply, with this question's snapshot (#1666). */
  readonly keep: (
    tx: TenantQuery,
    session: Session,
    asked: Asked,
    body: string,
  ) => Promise<Kept | undefined>;
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
    readonly page_address: string | null;
    readonly author: string;
  }>(
    `select c.owner_person_id, m.body, c.scope_record_id, c.page_address,
            m.author_actor_id::text as author
       from conversations c
       join conversation_messages m on m.business_id = c.business_id and m.conversation_id = c.id
      where c.business_id = $1 and c.id = $2 and m.id = $3 and m.role = 'person'
        and c.owner_actor_id = $4 and c.body_purged_at is null`,
    [tx.businessId, asked.conversationId, asked.messageId, session.actorId],
  );
  if (found === undefined) return undefined;
  const { body } = found;
  const page = await pageTaskOf(tx, found.scope_record_id, found.page_address);
  const context = await contextOf(tx, session, { ...asked, body }, page);
  return {
    model: await askedModel(tx, session, asked.conversationId, provider),
    provider,
    scope: {
      id: asked.conversationId,
      businessId: tx.businessId,
      ownerPersonId: found.owner_person_id,
    },
    body,
    reply: await replyTo(tx, session, asked),
    context,
    page,
    authors: [found.author, ...context.authors],
    sources: context.created.sources,
    subjects: subjectsOf(session),
    keep: async (on, now, ask, text) => await keep(on, now, ask, text, context.created.snapshot),
  };
}

/** What a handoff judges again: the question's model, its page task, its history sources and its sites. */
const judgedAgain = ({ model, page, sources, context }: Question) => ({
  model,
  page,
  sources,
  sites: context.sites,
});

/** The model asked for one message, and the answer kept as its reply. */
async function answerOnce(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  asked: Asked,
  { session, question }: { readonly session: Session; readonly question: Question },
  broker: ModelBroker,
  by: { readonly onPiece?: (text: string) => void; readonly accessToken?: string },
): Promise<ConversationReply | null> {
  // Pieces reach the caller only while they may hear the answer, judged as the reply is.
  const pieces = by.onPiece && judgedPieces(database, businessId, presented, asked, by.onPiece);
  // A read that came back after an earlier answer was kept and its flight ended: read again.
  const reread = async () =>
    await withSession(database, businessId, presented, (tx, now) => replyTo(tx, now, asked));
  const earlier = await reread();
  if (earlier !== undefined) return isCommandRefusal(earlier) ? null : answered(earlier, []);
  const operation = operationFor(question.model, question.provider);
  const paid =
    operation === OPENROUTER_CONVERSATION_KEY
      ? paidSeams({ database, businessId, presented, asked, ...question })
      : undefined;
  const handoff = { ...by, operation, ...judgedAgain(question) };
  const result = await callModelInConversation(
    database,
    businessId,
    { actorId: session.actorId, delegationId: null, attendedByPersonId: session.personId },
    {
      ...requestFor(question, asked, operation, {
        ...(pieces === undefined ? {} : { onPiece: pieces.push }),
        ...carriedBy(database, businessId, presented, broker, handoff),
      }),
      ...(paid && { paid: paid.seams }),
    },
    { ...broker, audit: auditAs(session.actorId) },
  );
  await pieces?.drained();
  if (!result.ok) return await unanswered(result, reread, operation);
  if (paid !== undefined) return paid.replied(question.context.cites, question.context.sites);
  // A model's words pass no command's door: what a message may not hold, a reply may not either.
  if (!usableReply(result.text)) return refusedWith('ANSWER_UNUSABLE');
  const kept = await withSession(
    database,
    businessId,
    presented,
    async (tx, now) => await question.keep(tx, now, asked, result.text),
  ).catch(heldElsewhere);
  if (kept === undefined || isCommandRefusal(kept)) return null;
  // The cites are what this call read, even where a twin request's answer was kept first.
  return answered(kept, question.context.cites, question.context.sites);
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
