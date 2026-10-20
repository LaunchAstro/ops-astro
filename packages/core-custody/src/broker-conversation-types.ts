// SPDX-License-Identifier: AGPL-3.0-only
//
// The conversation call's request, as the broker's conversation seam and the
// one-call-per-message module both read it. Types only, apart so neither
// module imports the other's.

import type { PlanAsk } from './broker-conversation-plan.ts';
import type { ClaimedField, PaidSeams } from './broker-types.ts';
import type { Handoff } from './carriage.ts';

/**
 * The conversation as the command layer found it, from its own row under the
 * caller's business (the conversation's table and its checks are SL12's; the
 * foreign key joins at the batch 3 join). The broker rechecks each fact
 * against the authenticated caller, never the body.
 */
export interface ConversationScope {
  readonly id: string;
  readonly businessId: string;
  readonly ownerPersonId: string;
}

export interface ConversationCallRequest {
  readonly conversation: ConversationScope;
  readonly operation: string;
  readonly fields: readonly ClaimedField[];
  /** The conversation's model (CS-7.30), checked as offered by the command layer; absent, the default. */
  readonly model?: string;
  /**
   * Where the answer's display text goes as it is written, for an operation
   * that streams (`pieces`). Provisional: only the settled answer is kept.
   */
  readonly onPiece?: (text: string) => void;
  /** The person's message the call answers: one message has at most one call (#1531). */
  readonly messageId?: string;
  /**
   * A carried call's handoff (live chat route B): the command layer's
   * judgements and the person's token, for the call the broker writes.
   */
  readonly carry?: (callId: string) => Handoff;
  /** A paid call's seams to the caller's own transactions (#1508); absent, nothing paid is sent. */
  readonly paid?: PaidSeams;
  /** On the owner's plan (#2175): who wrote each turn sent, the page and the earlier tasks. */
  readonly plan?: PlanAsk;
}
