// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-03's exchange: the agent's answer to a person's message. Stub (red).

import type { BusinessId, Database, VerifiedSubject } from '../../../core-records/src/index.ts';
import type { ModelBroker } from './model-call.ts';

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
) => Promise<ConversationReply | undefined>;

export function conversationExchange(_broker: ModelBroker): ConversationExchange {
  return async () => await Promise.resolve(undefined);
}
