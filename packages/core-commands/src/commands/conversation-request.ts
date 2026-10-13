// SPDX-License-Identifier: AGPL-3.0-only
//
// The conversation seam's request for one asked message (AW-03's exchange):
// its words, the context beside it, the model and the operation that asks it,
// and how the answer is heard (pieces, and a carried call's handoff).

import type {
  ConversationCallRequest,
  ConversationScope,
} from '../../../core-custody/src/index.ts';
import type { Context } from './conversation-context.ts';
import type { Asked } from './conversation-pieces.ts';

/** What the request reads of the question the exchange found. */
interface Questioned {
  readonly scope: ConversationScope;
  readonly body: string;
  readonly context: Context;
  readonly model: string | undefined | null;
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
    ...heard,
  };
}
