// SPDX-License-Identifier: AGPL-3.0-only
//
// #897 rule 8: a tab's start landing, and the reopened twin it folds in. A
// pure move over the drawer's state (`chats.ts`), split from `started.ts` for
// its line limit.
//
// **A fold reconciles before it folds.** Each of title, model and page takes
// the most recently stamped of the twin's value (when the twin set it) and the
// tab's own (when it differs from what the start sent), by the drawer's own
// counter, never a clock; with neither, what the start sent. Each field the
// server may then lack gets one write, after the twin's queue. The twin's
// lines join by server identity: only the start's own question and answer are
// dropped.

import type { AssistantMessage, AssistantPage, PlanCardState } from '@launchastro/ui';
import {
  change,
  READ_LINE,
  selecting,
  type AssistantState,
  type Chat,
  type Field,
} from './chats.ts';
import { noted } from './page-note.ts';

/** A write a replay leaves for its conversation, in this order. */
export type Write =
  | { readonly kind: 'rename'; readonly title: string }
  | { readonly kind: 'set_model'; readonly model: string }
  | { readonly kind: 'set_scope'; readonly page: AssistantPage };

const staled = (plan: NonNullable<AssistantMessage['plan']>): PlanCardState =>
  plan.state === 'unknown' ? 'unknown' : 'stale';

/** The cards plan version `version` replaces: every one not approved. */
export const replaced = (
  messages: readonly AssistantMessage[],
  version: number,
): AssistantMessage[] =>
  messages.map((each) =>
    each.plan !== undefined && each.plan.state !== 'approved'
      ? { ...each, plan: { ...each.plan, state: staled(each.plan), replacedBy: version } }
      : each,
  );

/** A start as it went, for a fold: its fields and the server's ids for its question and answer. */
export interface Landing {
  readonly title: string;
  readonly model: string | null;
  readonly page: AssistantPage | null;
  readonly questionId: string | null;
  readonly answerId: string | null;
  /** A fresh start, whose tab's changes meanwhile are queued after it; a replay's were dropped. */
  readonly queued: boolean;
}

/** A start landed: the state, the writes its conversation still needs, and the twin folded in. */
export interface Landed {
  readonly state: AssistantState;
  readonly writes: readonly Write[];
  readonly twin: string | null;
}

const samePage = (one: AssistantPage | null, other: AssistantPage | null): boolean =>
  one?.address === other?.address && one?.shows === other?.shows;

const same = (field: Field, one: unknown, other: unknown): boolean =>
  field === 'page'
    ? samePage(one as AssistantPage | null, other as AssistantPage | null)
    : one === other;

/**
 * Rule 8's choice for one field: the most recently stamped of the twin's value
 * (when the twin set it) and the tab's own (when it differs from what the start
 * sent), else what was sent; and whether the server, once every queued write
 * has landed, may hold anything else.
 */
function chosen(source: Chat, twin: Chat | undefined, landing: Landing, field: Field) {
  const sent = landing[field];
  const mine = same(field, source[field], sent)
    ? null
    : { value: source[field], at: source.stamps?.[field] ?? 0 };
  const at = twin?.stamps?.[field];
  const theirs = twin === undefined || at === undefined ? null : { value: twin[field], at };
  const pick = mine !== null && theirs !== null ? (mine.at > theirs.at ? mine : theirs) : null;
  const value = (pick ?? mine ?? theirs)?.value ?? sent;
  // Both queued, in an order unknown here: the write after them settles it.
  if (landing.queued && mine !== null && theirs !== null) return { value, write: true };
  // A fresh start sends its page again once it lands, over the twin's (`first-question.ts`).
  const again = landing.queued && field === 'page' && sent !== null;
  const holds =
    landing.queued && mine !== null ? mine.value : again ? sent : (theirs?.value ?? sent);
  return { value, write: !same(field, value, holds) };
}

/** The writes a fold leaves, in order, for each field whose chosen value the server may lack. */
function writesFor(chat: Chat, choices: Readonly<Record<Field, { write: boolean }>>): Write[] {
  const writes: Write[] = [];
  if (choices.title.write) writes.push({ kind: 'rename', title: chat.title });
  if (choices.model.write && chat.model !== null) {
    writes.push({ kind: 'set_model', model: chat.model });
  }
  if (choices.page.write && chat.page !== null) writes.push({ kind: 'set_scope', page: chat.page });
  return writes;
}

/** The twin's lines that join: all but the start's own question and answer, by server id. */
function joining(twin: Chat, landing: Landing): readonly AssistantMessage[] {
  const ids = [landing.questionId, landing.answerId].filter((id) => typeof id === 'string');
  const own = new Set(['page', ...ids.map((id) => `${READ_LINE}${id}`)]);
  return twin.messages.filter((line) =>
    ids.length === 0 ? !line.id.startsWith(READ_LINE) : !own.has(line.id),
  );
}

/** Tab `chat` with the twin's lines joined and each field as rule 8 chose it. */
function reconciled(chat: Chat, twin: Chat, landing: Landing) {
  const choices = {
    title: chosen(chat, twin, landing, 'title'),
    model: chosen(chat, twin, landing, 'model'),
    page: chosen(chat, twin, landing, 'page'),
  };
  const page = choices.page.value as AssistantPage | null;
  const merged: Chat = {
    ...chat,
    title: choices.title.value as string,
    model: choices.model.value as string | null,
    stamps: { ...twin.stamps, ...chat.stamps },
    asked: { ...twin.asked, ...chat.asked },
    messages: joining(twin, landing).reduce<readonly AssistantMessage[]>(
      (lines, line) => [
        ...(line.plan === undefined ? lines : replaced(lines, line.plan.version)),
        line,
      ],
      chat.messages,
    ),
  };
  const paged = page !== null && page !== chat.page ? noted(merged, page) : merged;
  return { chat: paged, writes: writesFor(paged, choices) };
}

/**
 * A live tab's start landed on its conversation; a closed tab takes nothing.
 * A twin reopened on that conversation folds into it, so it is never open
 * twice: its lines join by server identity, its questions still out and lines
 * on their way land here, and each field takes the most recent change (rule 8).
 */
export function landed(
  state: AssistantState,
  key: string,
  conversationId: string,
  landing: Landing,
): Landed {
  const source = state.chats.find((chat) => chat.key === key);
  if (source === undefined) return { state, writes: [], twin: null };
  const twin = state.chats.find(
    (chat) => chat.key !== key && chat.conversationId === conversationId,
  );
  const alone = { ...source, conversationId };
  const fold = twin === undefined ? null : reconciled(alone, twin, landing);
  const own = twin === undefined ? chosenAlone(alone, landing) : null;
  const single =
    twin === undefined
      ? state
      : {
          ...state,
          chats: state.chats.filter((chat) => chat !== twin),
          folded: { ...state.folded, [twin.key]: key },
          answering: {
            ...state.answering,
            [twin.key]: 0,
            [key]: (state.answering[key] ?? 0) + (state.answering[twin.key] ?? 0),
          },
        };
  const picked =
    twin !== undefined && state.selected === twin.key ? selecting(single, key) : single;
  const next = change(picked, key, () => fold?.chat ?? alone);
  return { state: next, writes: fold?.writes ?? own ?? [], twin: twin?.key ?? null };
}

/** With no twin, the writes for the fields the tab changed since a start that sent them unqueued. */
function chosenAlone(chat: Chat, landing: Landing): Write[] {
  return writesFor(chat, {
    title: chosen(chat, undefined, landing, 'title'),
    model: chosen(chat, undefined, landing, 'model'),
    page: chosen(chat, undefined, landing, 'page'),
  });
}

/** A live tab's start landed, as `landed` folds it, sent as the tab now is. */
export const started = (state: AssistantState, key: string, conversationId: string) => {
  const chat = state.chats.find((each) => each.key === key);
  const landing = {
    title: chat?.title ?? '',
    model: chat?.model ?? null,
    page: chat?.page ?? null,
  };
  return landed(state, key, conversationId, {
    ...landing,
    questionId: null,
    answerId: null,
    queued: true,
  }).state;
};
