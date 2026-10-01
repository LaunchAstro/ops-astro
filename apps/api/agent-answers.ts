// SPDX-License-Identifier: AGPL-3.0-only
//
// The two composition options the agent's answers need (AW-01's broker, AW-03's
// exchange), the executor a `model.call` goes to and the reply a kept message
// gets. Split from `app.ts`, which extends these options and calls both
// functions, to keep it under the 1,000-line cap.

import type {
  ConversationExchange,
  ConversationReply,
  ModelCallExecutor,
} from '../../packages/core-commands/src/index.ts';

export interface AgentAnswerOptions {
  /**
   * `model.call` on the agent prefix: the credential broker, when the
   * deployment configured one. Absent, the route answers that the part the
   * command rests on has not landed.
   */
  readonly executeModelCall?: ModelCallExecutor;
  /**
   * AW-03's exchange on the person path: after a person's message is kept,
   * the agent's answer through the broker. Absent, a message is kept and
   * nothing answers it.
   */
  readonly answerConversation?: ConversationExchange;
}

/**
 * AW-03: the agent's answer to the message a person just kept, where the
 * deployment mounted an exchange. After the command committed, never inside
 * it: the answer is a network call, and the message stays kept whatever it
 * says. Only `conversation.start` and `conversation.message` name a message.
 */
const MESSAGE_KEEPERS: ReadonlySet<string> = new Set([
  'conversation.start',
  'conversation.message',
]);

export async function replyTo(
  options: AgentAnswerOptions & { readonly database: Parameters<ConversationExchange>[0] },
  businessId: string,
  presented: Parameters<ConversationExchange>[2],
  kept: { readonly command: string; readonly detail: Readonly<Record<string, unknown>> },
): Promise<ConversationReply | null> {
  const exchange = options.answerConversation;
  if (exchange === undefined || !MESSAGE_KEEPERS.has(kept.command)) return null;
  const { conversationId, messageId } = kept.detail;
  if (typeof conversationId !== 'string' || typeof messageId !== 'string') return null;
  return await exchange(options.database, businessId, presented, { conversationId, messageId });
}

/**
 * `model.call` goes to the broker's executor where the deployment has one;
 * otherwise the agent envelope answers that it has not landed.
 */
export function executorFor<E>(
  name: string,
  options: AgentAnswerOptions,
  agentExecutor: E,
): E | ModelCallExecutor {
  return name === 'model.call' && options.executeModelCall !== undefined
    ? options.executeModelCall
    : agentExecutor;
}
