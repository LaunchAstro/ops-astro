// SPDX-License-Identifier: AGPL-3.0-only
//
// The exchange's side of a paid reply (#1508): the operation a conversation's
// model asks on, and the seams the broker's held path is given. The seams run
// in the caller's own transactions, resolved again from their session: the
// judgement at the handoff (the conversation, the session, the grants and the
// page, held as the reply's keep holds them, the page without waiting) and the
// keep itself, run in the broker's settling transaction so a settled paid
// call always has its reply.

import {
  CHATGPT_PLAN_CONVERSATION,
  CONVERSATION_ANSWER,
  CONVERSATION_MODELS,
  conversationOperationOf,
} from '../../../core-connectors/src/index.ts';
import type { ModelCallResult, PaidSeams } from '../../../core-custody/src/index.ts';
import { subjectsOf, withSession } from '../../../core-records/src/index.ts';
import { holdCoveringGrants } from '../../../core-runtime/src/index.ts';
import type {
  BusinessId,
  Database,
  Session,
  TenantQuery,
  VerifiedSubject,
} from '../../../core-records/src/index.ts';
import { pageOf, type Cite } from './conversation-context.ts';
import { hearingAt, heldElsewhere, type Asked } from './conversation-pieces.ts';
import {
  answered,
  budgetWith,
  heldWith,
  planHeldWith,
  refusedWith,
  releasedWith,
  type ConversationReply,
  type Kept,
} from './conversation-replies.ts';
import { bounded } from './conversations.ts';
import { pageTaskOf } from './conversation-page-task.ts';
import { isCommandRefusal } from './refusal.ts';
import { storableText } from './values.ts';

/** A reply's body is a message's (0092). */
const REPLY_LIMIT = 20_000;

/** A model's words pass no command's door: what a message may not hold, a reply may not either. */
export const usableReply = (text: string): boolean =>
  bounded(text, REPLY_LIMIT) && storableText(text);

/** The operation the conversation's model answers on: a paid model's provider has its own. */
export function operationFor(model: string | undefined | null): string {
  const provider = CONVERSATION_MODELS.find((one) => one.id === model)?.provider;
  return provider === undefined ? CONVERSATION_ANSWER.key : conversationOperationOf(provider);
}

/**
 * At a paid send's handoff, in the caller's transaction: the conversation
 * still theirs and kept, their session and grant live (`hearingAt`), its model
 * still the paid one asked, the page the one the context read, and that page still no client's and theirs to
 * read, it and the caller's task grants held for share without waiting: a
 * task or grant being written refuses.
 */
async function stillAsked(
  tx: TenantQuery,
  session: Session,
  ask: Pick<PaidAsk, 'asked' | 'page' | 'sources' | 'model'>,
): Promise<boolean> {
  const { asked, page, sources } = ask;
  if ((await hearingAt(tx, session, asked, 'share')) === undefined) return false;
  const [now] = await tx.query<{
    readonly page: string | null;
    readonly address: string | null;
    readonly model: string | null;
  }>(
    `select scope_record_id as page, page_address as address, model_id as model
       from conversations where business_id = $1 and id = $2`,
    [tx.businessId, asked.conversationId],
  );
  if (now === undefined || now.model !== ask.model) return false;
  if ((await pageTaskOf(tx, now.page, now.address)) !== page) return false;
  if (page === null && sources.length === 0) return true;
  // The task grants held too, so a revocation of the read waits for the send, as the conversation's do.
  await holdCoveringGrants(tx, subjectsOf(session), 'task', 'nowait');
  // The page, then each task the earlier exchanges sent may carry (#1666), in id order.
  for (const task of [...(page === null ? [] : [page]), ...sources.toSorted()]) {
    // eslint-disable-next-line no-await-in-loop -- one lock after another, in order
    if (typeof (await pageOf(tx, session, task, 'share nowait')) === 'string') return false;
  }
  return true;
}

export interface PaidAsk {
  readonly database: Database;
  readonly businessId: BusinessId;
  readonly presented: VerifiedSubject;
  readonly asked: Asked;
  /** The page task the context read, if any. */
  readonly page: string | null;
  /** The tasks the earlier exchanges sent may carry (#1666): each still the caller's to use at the handoff. */
  readonly sources: readonly string[];
  /** The paid model the conversation was asked on: still its model at the handoff. */
  readonly model: string | undefined | null;
  /** Who wrote the asked message and each earlier person turn read. */
  readonly authors: readonly string[];
  /** The exchange's keep: the reply under the conversation's lock, or the one already kept. */
  readonly keep: (
    tx: TenantQuery,
    session: Session,
    asked: Asked,
    body: string,
  ) => Promise<Kept | undefined>;
}

/** A paid call's seams, and the reply its settle kept, as the panel is answered. */
export function paidSeams(ask: PaidAsk): {
  readonly seams: PaidSeams;
  readonly replied: (cites: readonly Cite[]) => ConversationReply | null;
} {
  const { database, businessId, presented, asked } = ask;
  let kept: Kept | undefined;
  const seams: PaidSeams = {
    authors: ask.authors,
    asCaller: async (work) => {
      // Boxed, so a refusal is told apart from whatever the work answers.
      const done = await withSession(database, businessId, presented, async (tx, session) => ({
        value: await work(tx, {
          stillAdmitted: async () => await stillAsked(tx, session, ask),
          keep: async (text) => {
            if (!usableReply(text)) return false;
            kept = await ask.keep(tx, session, asked, text);
            return kept !== undefined;
          },
        }),
      })).catch(heldElsewhere);
      return done === undefined || isCommandRefusal(done) ? undefined : done.value;
    },
  };
  return { seams, replied: (cites) => (kept === undefined ? null : answered(kept, cites)) };
}

/**
 * A call that kept no reply, in the panel's words. Told the message's call is
 * answering or ended, the reply is read again: a twin's answer kept while this
 * one waited is that reply, never a reason to send the message again.
 */
export async function unanswered(
  result: Exclude<ModelCallResult, { readonly ok: true }>,
  reread: () => Promise<Kept | object | undefined>,
  operation?: string,
): Promise<ConversationReply | null> {
  if (result.code === 'STILL_ANSWERING' || result.code === 'ANSWER_ENDED') {
    const kept = await reread();
    if (kept !== undefined) return isCommandRefusal(kept) ? null : answered(kept as Kept, []);
  }
  if (result.code === 'CALL_RELEASED') return releasedWith(result.reason);
  if (result.code === 'LIABILITY_UNKNOWN' && 'heldMinor' in result && result.heldMinor > 0) {
    return heldWith(result.heldMinor);
  }
  // A plan call went out before it was held: told by what the plan answered (#2175).
  if (result.code === 'LIABILITY_UNKNOWN' && operation === CHATGPT_PLAN_CONVERSATION.key) {
    return planHeldWith('providerCode' in result ? result.providerCode : null);
  }
  if (result.code === 'BUDGET_UNAVAILABLE' && 'leftMinor' in result) {
    return budgetWith(result.leftMinor);
  }
  return refusedWith(result.code);
}
