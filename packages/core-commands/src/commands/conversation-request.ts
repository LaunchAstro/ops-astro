// SPDX-License-Identifier: AGPL-3.0-only
//
// The conversation seam's request for one asked message (AW-03's exchange):
// its words, the context beside it, the model and the operation that asks it,
// and how the answer is heard (pieces, and a carried call's handoff). A call
// on the owner's ChatGPT plan (#2175) names who wrote each turn sent, its page,
// the earlier exchanges' tasks, the site pages listed and whose grants read
// them, for the broker to judge under its locks (S2100-1).

import { CHATGPT_PLAN_CONVERSATION } from '../../../core-connectors/src/index.ts';
import type {
  ConversationCallRequest,
  ConversationScope,
} from '../../../core-custody/src/index.ts';
import type { Subject } from '../../../core-records/src/index.ts';
import type { Context } from './conversation-context.ts';
import type { Asked } from './conversation-pieces.ts';

/** What the request reads of the question the exchange found. */
interface Questioned {
  readonly scope: ConversationScope;
  readonly body: string;
  readonly context: Context;
  readonly model: string | undefined | null;
  readonly authors: readonly string[];
  readonly page: string | null;
  readonly sources: readonly string[];
  readonly subjects: readonly Subject[];
}

/** The conversation seam's request for the question: its words and context, its model, and how it is heard. */
export function requestFor(
  question: Questioned,
  asked: Asked,
  operation: string,
  heard: Pick<ConversationCallRequest, 'onPiece' | 'carry'>,
): ConversationCallRequest {
  return {
    conversation: question.scope,
    messageId: asked.messageId,
    operation,
    fields: [
      ...question.context.fields.map((field) => ({ ...field, source: 'outside' as const })),
      { name: 'message', source: 'outside', value: question.body },
    ],
    ...(question.model === undefined || question.model === null ? {} : { model: question.model }),
    ...(operation === CHATGPT_PLAN_CONVERSATION.key
      ? {
          plan: {
            authors: question.authors,
            page: question.page,
            sources: question.sources,
            sites: question.context.sites,
            subjects: question.subjects,
          },
        }
      : {}),
    ...heard,
  };
}
