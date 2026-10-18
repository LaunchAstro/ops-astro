// SPDX-License-Identifier: AGPL-3.0-only
//
// A tab's first question (`views/assistant.tsx`): the start that makes its
// conversation, the agent's answer, and the writes that follow a start. Split
// from the view for its line limit.

import type { AssistantPage } from '@launchastro/ui';
import type {
  CallResult,
  CommandOutcome,
  ConversationReply,
  OperationsClient,
} from '../operations/client.ts';
import { settle } from '../records/use-command.ts';
import { started, type Chat } from './chats.ts';
import { citesOf } from './cites.ts';
import type { Baseline } from './proposals.ts';
import type { Kept, Resends } from './resend.ts';
import type { Store } from './store.ts';
import type { Subject } from './subject.ts';
import { withPieces } from './writing.ts';

export const KEPT = 'Kept in this conversation. The agent does not answer here yet.';

export type Sent = Promise<CallResult<CommandOutcome>>;

export interface Opening {
  readonly chat: Chat;
  readonly body: string;
  readonly subject: Subject;
  readonly scope: { readonly kind: 'task'; readonly id: string } | null;
  /** The chat's task as read before this send. */
  readonly baseline: Baseline | null;
}

/**
 * The tab's lost questions, and how an answer's edit is bound to a revision.
 * A replay's answer is bound to what its first attempt read, not this send's
 * fresh read, so an old proposal cannot overwrite newer work (#897).
 */
export interface Replays {
  readonly resent: Resends;
  readonly keep: (
    reply: { readonly messageId: string; readonly body: string },
    at: Baseline | null,
  ) => void;
}

/** The answer as `replied` places it, then any edit it proposes bound to the attempt's own read. */
function answeredFor(
  store: Store,
  key: string,
  reply: ConversationReply | undefined,
  sent: Kept,
  replays: Replays,
): void {
  replied(store, key, reply);
  if (reply?.answered === true && reply.plan === undefined)
    replays.keep(reply, sent.baseline ?? null);
}

/** The agent's answer to a kept question, why there is none, or that none comes here. */
export function replied(store: Store, key: string, reply: ConversationReply | undefined): void {
  if (reply === undefined) store.line(key, 'note', KEPT);
  else if (reply.answered && reply.plan !== undefined) store.plan(key, reply.body, reply.plan);
  else if (reply.answered) store.answer(key, reply, undefined, citesOf(reply.cites));
  else store.line(key, 'failed', reply.words);
}

/** The tab's first question with its model, its answer, a reopened twin's later lines, then its page. */
export async function startWith(
  client: OperationsClient,
  store: Store,
  opening: Opening,
  report: (key: string, sent: Sent) => Promise<boolean>,
  replays: Replays,
): Promise<string | null> {
  const { chat, body, subject, scope, baseline } = opening;
  // The tab as the question was asked: a model chosen before it rides in the
  // start, so the first answer is asked of it (CS-7.30); none chosen, the
  // default. A title, page or model chosen while it waits follows it in turn.
  const { title, page, model } = chat;
  const chosen = model === null ? {} : { model };
  const start = { body, title, subject: subject.label, scope, ...chosen };
  // A resend of a start whose answer was lost goes under the first identity (`resend.ts`).
  const asked = {
    command: 'conversation.start',
    question: body,
    request: start,
    baseline,
  } as const;
  let sent: Kept | undefined;
  const settled = settle(
    await replays.resent.send(chat.key, asked, (request, operationId, sending) => {
      sent = sending;
      return withPieces(store, chat.key, (by) =>
        client.mutate('conversation.start', request, { ...by, operationId }),
      );
    }),
  );
  const id = settled.kind === 'ok' ? settled.value.detail?.['conversationId'] : undefined;
  if (typeof id !== 'string') {
    store.line(
      chat.key,
      'failed',
      settled.kind === 'ok' ? 'No conversation came back.' : settled.because,
    );
    return null;
  }
  const reply = settled.kind === 'ok' ? settled.value.reply : undefined;
  if (sent === undefined) replied(store, chat.key, reply);
  else answeredFor(store, chat.key, reply, sent, replays);
  store.update((current) => started(current, chat.key, id));
  if (page !== null) await report(chat.key, setScope(client, id, page));
  return id;
}

/** A later question in a started tab, and its answer or why none came. */
export async function askAgain(
  client: OperationsClient,
  store: Store,
  key: string,
  message: {
    readonly conversationId: string;
    readonly body: string;
    readonly baseline: Baseline | null;
  },
  replays: Replays,
): Promise<void> {
  const { conversationId, body, baseline } = message;
  const asked = {
    command: 'conversation.message',
    question: body,
    request: { conversationId, body },
    baseline,
  } as const;
  let sent: Kept | undefined;
  const settled = settle(
    await replays.resent.send(key, asked, (request, operationId, sending) => {
      sent = sending;
      return withPieces(store, key, (by) =>
        client.mutate('conversation.message', request, { ...by, operationId }),
      );
    }),
  );
  if (settled.kind !== 'ok') store.line(key, 'failed', settled.because);
  else if (sent === undefined) replied(store, key, settled.value.reply);
  else answeredFor(store, key, settled.value.reply, sent, replays);
}

export const setScope = (
  client: OperationsClient,
  conversationId: string,
  page: AssistantPage,
): Sent => client.mutate('conversation.set_scope', { conversationId, page });

export const setModel = (client: OperationsClient, conversationId: string, model: string): Sent =>
  client.mutate('conversation.set_model', { conversationId, model });
