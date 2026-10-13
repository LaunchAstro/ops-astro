// SPDX-License-Identifier: AGPL-3.0-only
//
// The two composition options the agent's answers need (AW-01's broker, AW-03's
// exchange), the executor a `model.call` goes to and the reply a kept message
// gets. Split from `app.ts`, which extends these options and calls both
// functions, to keep it under the 1,000-line cap.

import type { Context } from 'hono';
import { streamSSE, type SSEMessage } from 'hono/streaming';
import { holdQuotaSlot } from '../../packages/core-records/src/index.ts';
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

type Answering = AgentAnswerOptions & { readonly database: Parameters<ConversationExchange>[0] };

interface Kept {
  readonly command: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export async function replyTo(
  options: Answering,
  businessId: string,
  presented: Parameters<ConversationExchange>[2],
  kept: Kept,
  onPiece?: (text: string) => void,
): Promise<ConversationReply | null> {
  const exchange = options.answerConversation;
  if (exchange === undefined || !MESSAGE_KEEPERS.has(kept.command)) return null;
  const { conversationId, messageId } = kept.detail;
  if (typeof conversationId !== 'string' || typeof messageId !== 'string') return null;
  const asked = { conversationId, messageId };
  return await exchange(options.database, businessId, presented, asked, onPiece);
}

/** The panel asks for the answer as it is written, and an exchange will answer this command. */
export const asksForPieces = (
  context: Context,
  options: AgentAnswerOptions,
  command: string,
): boolean =>
  options.answerConversation !== undefined &&
  MESSAGE_KEEPERS.has(command) &&
  (context.req.header('accept') ?? '').includes('text/event-stream');

/**
 * The kept message's answer as an event stream: a `piece` event for each
 * display text as the model writes it, numbered from 0 in its `id`, then one
 * `outcome` event whose data is exactly the JSON body the request answers
 * without a stream. Pieces are provisional; only the outcome's reply is kept.
 * A browser that leaves stops only the writing: the answer still settles and
 * its reply is kept, read on the next `conversation.read`. Like the JSON
 * answer it replaces, it holds the caller's concurrent slot until the answer
 * ends, not only until the response starts (API-3).
 */
export function streamedReply(
  context: Context,
  options: Answering,
  businessId: string,
  presented: Parameters<ConversationExchange>[2],
  settled: Kept,
): Response {
  const release = holdQuotaSlot();
  return streamSSE(context, async (stream) => {
    try {
      // One write at a time, in order; a write to a stream the browser left is dropped.
      let written = Promise.resolve();
      const after = async (previous: Promise<void>, message: SSEMessage): Promise<void> => {
        await previous;
        if (!stream.aborted) await stream.writeSSE(message).catch(() => {});
      };
      const write = (message: SSEMessage): void => {
        written = after(written, message);
      };
      let seq = 0;
      const reply = await replyTo(options, businessId, presented, settled, (data) => {
        write({ event: 'piece', id: String(seq), data });
        seq += 1;
      });
      write({
        event: 'outcome',
        data: JSON.stringify({ ...settled, ...(reply === null ? {} : { reply }) }),
      });
      await written;
    } finally {
      release();
    }
  });
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
