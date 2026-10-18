// SPDX-License-Identifier: AGPL-3.0-only
//
// #897: a tab's start landing, and a replayed start's restore. Pure moves over
// the drawer's state (`chats.ts`), split from it for its line limit.
//
// **A replay restores its own conversation and nobody else's.** A start whose
// answer was lost is kept with its frozen request and what the tab was on
// (`resend.ts`). When its resend succeeds, `replayed` decides where its answer
// goes. A tab still unstarted becomes conversation A again: the title, model
// and page are the tab's own, A's page is put back if the tab gave it up, and
// each field that differs from A's request is written after the replay. A tab
// started meanwhile on another conversation keeps everything made since; A's
// question and answer go to a tab on A, a new one carrying A's own title,
// model, page and scope (with its task), or one already open on A, which is
// given only what it lacks. Lines are matched by the server's message ids, so an answer
// a reopened conversation already shows is never drawn twice, and one it was
// missing lands straight after its question. A restore takes values only from
// the tab's own kept attempt, so it never widens scope.

import type { AssistantMessage, AssistantPage, PlanCardState } from '@launchastro/ui';
import {
  blank,
  change,
  has,
  keyIn,
  READ_LINE,
  selecting,
  type AssistantState,
  type Chat,
  type StandingScope,
} from './chats.ts';
import { gaveUp, noted, putBack } from './page-note.ts';
import { PROPOSAL_LINE } from './proposals.ts';

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

/**
 * A live tab's first question started its conversation; a closed tab takes nothing.
 * Its reopened twin folds into it, so the conversation is never open twice.
 * Read lines repeat the first question already here. Later lines follow, each
 * plan version replacing older ones; questions still out and lines on their
 * way to the twin belong to this tab.
 */
export function started(
  state: AssistantState,
  key: string,
  conversationId: string,
): AssistantState {
  if (!has(state, key)) return state;
  const twin = state.chats.find(
    (chat) => chat.key !== key && chat.conversationId === conversationId,
  );
  const since = twin?.messages.filter((message) => !message.id.startsWith(READ_LINE)) ?? [];
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
  const chosen =
    twin !== undefined && state.selected === twin.key ? selecting(single, key) : single;
  return change(chosen, key, (chat) => ({
    ...chat,
    conversationId,
    asked: { ...twin?.asked, ...chat.asked },
    messages: since.reduce<readonly AssistantMessage[]>(
      (lines, line) => [
        ...(line.plan === undefined ? lines : replaced(lines, line.plan.version)),
        line,
      ],
      chat.messages,
    ),
  }));
}

/** Tab `key` without `page` if it still holds that very add of it: it went with a lost start. */
export const lost = (state: AssistantState, key: string, page: AssistantPage): AssistantState =>
  change(state, key, (chat) => (chat.page === page ? gaveUp(chat) : chat));

/** A replayed start as its first attempt went, and the resend's own question line. */
export interface Replay {
  readonly conversationId: string;
  readonly title: string;
  readonly model: string | null;
  readonly page: AssistantPage | null;
  readonly scope: StandingScope;
  readonly body: string;
  /** The server's ids for its question and its answer; no answer id for a refusal. */
  readonly questionId: string | null;
  readonly answerId: string | null;
  /** The resend's question line in the asking tab. */
  readonly asked: string;
}

/** A write a replay leaves for its conversation, in this order. */
export type Write =
  | { readonly kind: 'rename'; readonly title: string }
  | { readonly kind: 'set_model'; readonly model: string }
  | { readonly kind: 'set_scope'; readonly page: AssistantPage };

export interface Restored {
  readonly state: AssistantState;
  /** The tab and line A's answer goes after, or none when that tab already shows it. */
  readonly answer: { readonly key: string; readonly after: string } | null;
  /** Whether the asking tab is told the answer went to a tab of its own. */
  readonly apart: boolean;
  readonly writes: readonly Write[];
}

const samePage = (one: AssistantPage | null, other: AssistantPage | null): boolean =>
  one?.address === other?.address && one?.shows === other?.shows;

/** Case 1: the asking tab, still unstarted, becomes A again, keeping what was set on it since. */
function unstarted(state: AssistantState, from: string, replay: Replay): Restored {
  const begun = change(started(state, from, replay.conversationId), from, (chat) => {
    const back =
      chat.page === null && replay.page !== null && chat.gave === replay.page
        ? putBack(chat, replay.page)
        : chat;
    return { ...back, asked: { ...back.asked, [replay.asked]: replay.page?.address ?? null } };
  });
  const chat = begun.chats.find((each) => each.key === keyIn(begun, from));
  const writes: Write[] = [];
  if (chat !== undefined && chat.title !== replay.title) {
    writes.push({ kind: 'rename', title: chat.title });
  }
  if (chat !== undefined && chat.model !== null && chat.model !== replay.model) {
    writes.push({ kind: 'set_model', model: chat.model });
  }
  if (chat !== undefined && chat.page !== null && !samePage(chat.page, replay.page)) {
    writes.push({ kind: 'set_scope', page: chat.page });
  }
  return { state: begun, answer: { key: from, after: replay.asked }, apart: false, writes };
}

/** A's question as a line carrying its server id, so a later read of A matches it. */
const questionOf = (replay: Replay): AssistantMessage => ({
  id: `${READ_LINE}${replay.questionId ?? replay.asked}`,
  role: 'user',
  body: replay.body,
  cites: [],
});

/** Case 2a: a new tab on A, selected, with A's own title, model, page and scope (its task). */
function apart(state: AssistantState, replay: Replay): Restored {
  const made: Chat = {
    ...blank(state.next, [], replay.scope),
    conversationId: replay.conversationId,
    title: replay.title,
    model: replay.model,
  };
  const paged = replay.page === null ? made : noted(made, replay.page);
  const question = questionOf(replay);
  const tab = {
    ...paged,
    messages: [...paged.messages, question],
    asked: { [question.id]: replay.page?.address ?? null },
  };
  const opened = { ...state, chats: [...state.chats, tab], next: state.next + 1 };
  const answer = { key: tab.key, after: question.id };
  return { state: selecting(opened, tab.key), answer, apart: true, writes: [] };
}

/** Whether tab `chat` already shows the answer with server id `id`. */
const shows = (chat: Chat, id: string): boolean =>
  chat.messages.some(
    (line) => line.id === `${READ_LINE}${id}` || line.id === `${PROPOSAL_LINE}${id}`,
  );

/** Case 2b: tab `open`, already on A, given only what it lacks; A's answer only if it is missing. */
function joined(state: AssistantState, open: Chat, replay: Replay, from: string): Restored {
  const filled = change(state, open.key, (chat) => {
    const paged = chat.page === null && replay.page !== null ? noted(chat, replay.page) : chat;
    const bare = chat.scope.client === null && chat.scope.task === null;
    const scope = bare ? replay.scope : chat.scope;
    return { ...paged, scope, model: chat.model ?? replay.model };
  });
  const question = questionOf(replay);
  const asked = open.messages.some((line) => line.id === question.id);
  const added = asked
    ? filled
    : change(filled, open.key, (chat) => ({ ...chat, messages: [...chat.messages, question] }));
  // A tab whose read is still out takes A's lines from that read.
  const missing =
    open.reading !== true && (replay.answerId === null || !shows(open, replay.answerId));
  const answer = missing ? { key: open.key, after: question.id } : null;
  const elsewhere = open.key !== keyIn(state, from);
  return { state: selecting(added, open.key), answer, apart: elsewhere, writes: [] };
}

/**
 * A replayed start's restore, from the asking tab `from`: the state, where A's
 * answer goes, and the writes its conversation still needs, in order.
 */
export function replayed(state: AssistantState, from: string, replay: Replay): Restored {
  const source = state.chats.find((chat) => chat.key === keyIn(state, from));
  if (source === undefined || source.conversationId === null) {
    return unstarted(state, from, replay);
  }
  const open = state.chats.find((chat) => chat.conversationId === replay.conversationId);
  if (open === undefined) return apart(state, replay);
  return joined(state, open, replay, from);
}
