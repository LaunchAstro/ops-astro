// SPDX-License-Identifier: AGPL-3.0-only
//
// A tab's first question (`views/assistant.tsx`): the start that makes its
// conversation, the agent's answer, and the writes that follow a start. Split
// from the view for its line limit.
//
// **A page goes with one start** (#897). A start whose answer was lost is kept
// with the page it carried (`resend.ts`), and the tab gives that page up, so a
// later question in the tab does not send the page's record content to a
// second conversation. A start is checked when it is dispatched, after its
// wait, not when it was queued, so a question queued behind a lost start never
// carries its page either. Only the kept start's own replay carries it.
//
// **A replay restores, then writes** (`started.ts`, `fold.ts`): its answer goes
// where the restore says, its edit bound to what its first attempt read before
// the line is drawn, then each field changed since, after the tab's queue.

import type { AssistantPage } from '@launchastro/ui';
import type {
  CallResult,
  CommandOutcome,
  ConversationReply,
  OperationsClient,
} from '../operations/client.ts';
import { settle } from '../records/use-command.ts';
import type { Chat, StandingScope } from './chats.ts';
import { citesOf } from './cites.ts';
import type { Baseline } from './proposals.ts';
import type { Asked, Kept, Resends } from './resend.ts';
import { landed, type Write } from './fold.ts';
import { lost, replayed, replayOf } from './started.ts';
import type { Store } from './store.ts';
import type { Subject } from './subject.ts';
import { withPieces } from './writing.ts';

export const KEPT = 'Kept in this conversation. The agent does not answer here yet.';

export const APART = 'Already asked in a conversation of its own: its answer is in that tab.';

export type Sent = Promise<CallResult<CommandOutcome>>;

export interface Opening {
  readonly chat: Chat;
  readonly body: string;
  readonly subject: Subject;
  readonly scope: { readonly kind: 'task'; readonly id: string } | null;
  /** The chat's task as read before this send. */
  readonly baseline: Baseline | null;
  /** The question's line in the asking tab. */
  readonly question: string;
}

/** What a start keeps beside its request: the page it carried, by reference, and the tab's scope. */
export interface Context {
  readonly page: AssistantPage | null;
  readonly scope: StandingScope;
}

type Attempt = Kept<Context>;

/**
 * The tab's lost questions, and how an answer's edit is bound to a revision.
 * A replay's answer is bound to what its first attempt read, not this send's
 * fresh read, so an old proposal cannot overwrite newer work (#897).
 */
export interface Replays {
  readonly resent: Resends<Context>;
  readonly keep: (
    reply: { readonly messageId: string; readonly body: string },
    at: Baseline | null,
  ) => void;
}

/** What a start goes through: the client, the drawer's own store, a write's report, the replays. */
export interface Sending {
  readonly client: OperationsClient;
  readonly store: Store;
  readonly report: (key: string, sent: Sent) => Promise<boolean>;
  readonly replays: Replays;
  /** Each tab's queue: its start, then its writes in turn (`views/assistant.tsx`). */
  readonly starts: Map<string, Promise<string | null>>;
}

/** The agent's answer to a kept question, why there is none, or that none comes here. */
export function replied(
  store: Store,
  key: string,
  reply: ConversationReply | undefined,
  after?: string,
): void {
  if (reply === undefined) store.line(key, 'note', KEPT, after);
  else if (reply.answered && reply.plan !== undefined) {
    store.plan(key, reply.body, reply.plan, after);
  } else if (reply.answered) store.answer(key, reply, after, citesOf(reply.cites));
  else store.line(key, 'failed', reply.words, after);
}

/** The edit an answer proposes bound to the attempt's own read, before its card is drawn. */
function bound(reply: ConversationReply | undefined, sent: Attempt, replays: Replays): void {
  if (reply?.answered === true && reply.plan === undefined)
    replays.keep(reply, sent.baseline ?? null);
}

export const setScope = (
  client: OperationsClient,
  conversationId: string,
  page: AssistantPage,
): Sent => client.mutate('conversation.set_scope', { conversationId, page });

export const setModel = (client: OperationsClient, conversationId: string, model: string): Sent =>
  client.mutate('conversation.set_model', { conversationId, model });

const written = (client: OperationsClient, conversationId: string, write: Write): Sent => {
  if (write.kind === 'rename') {
    return client.mutate('conversation.rename', { conversationId, title: write.title });
  }
  return write.kind === 'set_model'
    ? setModel(client, conversationId, write.model)
    : setScope(client, conversationId, write.page);
};

/** A write as tab `chat` stands when it goes, so a change made while it waited is never undone (S1920-2). */
function asNow(chat: Chat, write: Write): Write | null {
  if (write.kind === 'rename') return { kind: 'rename', title: chat.title };
  if (write.kind === 'set_model')
    return chat.model === null ? null : { ...write, model: chat.model };
  return chat.page === null ? null : { ...write, page: chat.page };
}

/** A kept start replayed: its restore, its answer where that puts it, then its writes. */
function replayIn(
  sending: Sending,
  key: string,
  outcome: CommandOutcome,
  replay: { readonly sent: Attempt; readonly question: string },
): void {
  const { store, replays } = sending;
  const { sent, question } = replay;
  const restored = replayed(store.now(), key, replayOf(sent, outcome, question));
  store.update(() => restored.state);
  if (restored.apart) store.line(key, 'note', APART);
  bound(outcome.reply, sent, replays);
  if (restored.answer !== null) {
    replied(store, restored.answer.key, outcome.reply, restored.answer.after);
  }
  follow(sending, key, String(outcome.detail?.['conversationId']), restored);
}

/**
 * A twin's lost questions moved to the tab it folded into, and the writes a
 * fold or replay leaves, sent after everything queued on that tab and on the
 * twin, so the server's last write is the value chosen (rule 8).
 */
function follow(
  sending: Sending,
  key: string,
  id: string,
  fold: { readonly twin?: string | null; readonly writes: readonly Write[] },
): void {
  const { client, report, replays, starts } = sending;
  const twin = fold.twin ?? null;
  if (twin !== null) replays.resent.fold(twin, key);
  if (twin === null && fold.writes.length === 0) return;
  const waits = [starts.get(key), twin === null ? undefined : starts.get(twin)];
  const turn = Promise.all(waits).then(async () => {
    for (const write of fold.writes) {
      const tab = sending.store.now().chats.find((chat) => chat.key === key);
      const value = tab === undefined ? write : asNow(tab, write);
      // oxlint-disable-next-line no-await-in-loop -- each write in turn, as the tab made them
      if (value !== null) await report(key, written(client, id, value));
    }
    return id;
  });
  starts.set(key, turn);
}

/** A start with no conversation back: why, and the page given up if a lost start kept it. */
function failed(
  sending: Sending,
  on: Store,
  key: string,
  start: { readonly page: AssistantPage | null; readonly because: string | null },
): void {
  const { page, because } = start;
  on.line(key, 'failed', because ?? 'No conversation came back.');
  if (page !== null && sending.replays.resent.carries(key, (kept) => kept.page === page)) {
    sending.store.update((current) => lost(current, key, page));
  }
}

/**
 * The start as the tab was when the question was asked: a model chosen before
 * it rides in the start, so the first answer is asked of it (CS-7.30); none
 * chosen, the default. A title, page or model chosen while it waits follows it
 * in turn. A page a lost start kept went with that start, checked now, at
 * dispatch, so this one goes without it.
 */
function startOf(opening: Opening, replays: Replays): Asked<Context> {
  const { chat, body, subject, scope, baseline } = opening;
  const { title, model } = chat;
  const carried = (kept: Context): boolean => kept.page === chat.page;
  const page = chat.page !== null && replays.resent.carries(chat.key, carried) ? null : chat.page;
  const chosen = model === null ? {} : { model };
  const request = { body, title, subject: subject.label, scope, ...chosen, ...(page && { page }) };
  const context = { page, scope: chat.scope };
  return { command: 'conversation.start', question: body, request, baseline, context };
}

/** The tab's first question with its model, its answer, a reopened twin's later lines, then its page. */
export async function startWith(
  sending: Sending,
  on: Store,
  opening: Opening,
): Promise<string | null> {
  const { client, store, report, replays } = sending;
  const { chat, body, question } = opening;
  const asked = startOf(opening, replays);
  const page = asked.context?.page ?? null;
  // A resend of a start whose answer was lost goes under the first identity (`resend.ts`).
  const replaying = replays.resent.holds(chat.key, 'conversation.start', body);
  let sent: Attempt = { ...asked, operationId: '' };
  const settled = settle(
    await replays.resent.send(chat.key, asked, (request, operationId, kept) => {
      sent = kept;
      return withPieces(on, chat.key, (by) =>
        client.mutate('conversation.start', request, { ...by, operationId }),
      );
    }),
  );
  const id = settled.kind === 'ok' ? settled.value.detail?.['conversationId'] : undefined;
  if (typeof id !== 'string') {
    const because = settled.kind === 'ok' ? null : settled.because;
    failed(sending, on, chat.key, { page, because });
    return null;
  }
  if (replaying && settled.kind === 'ok') {
    replayIn(sending, chat.key, settled.value, { sent, question });
    return id;
  }
  const reply = settled.kind === 'ok' ? settled.value.reply : undefined;
  bound(reply, sent, replays);
  replied(on, chat.key, reply);
  const messageId = settled.kind === 'ok' ? settled.value.detail?.['messageId'] : undefined;
  const fold = landed(store.now(), chat.key, id, {
    title: chat.title,
    model: chat.model,
    page,
    questionId: typeof messageId === 'string' ? messageId : null,
    answerId: reply?.answered === true ? reply.messageId : null,
    queued: true,
  });
  store.update(() => fold.state);
  if (page !== null) await report(chat.key, setScope(client, id, page));
  follow(sending, chat.key, id, fold);
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
  let sent: Attempt | undefined;
  const settled = settle(
    await replays.resent.send(key, asked, (request, operationId, sending) => {
      sent = sending;
      return withPieces(store, key, (by) =>
        client.mutate('conversation.message', request, { ...by, operationId }),
      );
    }),
  );
  if (settled.kind !== 'ok') {
    store.line(key, 'failed', settled.because);
    return;
  }
  if (sent !== undefined) bound(settled.value.reply, sent, replays);
  replied(store, key, settled.value.reply);
}
