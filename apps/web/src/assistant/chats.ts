// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11: the drawer's open conversations and the ask seam.
//
// Pure moves over the drawer's session state, so each is tested without a
// document. A tab is a conversation the person has open; one with no
// `conversationId` has not been started, because a conversation begins with its
// first message (`conversation.start`), and nothing is stored before that.
//
// **The ask seam** is one move, `ask`: an entry names the widget it came from,
// the drafted question and the scope. It opens a fresh tab, drafts the
// question, and cites the widget; a second ask replaces the first citation
// rather than adding to it. A direct open from the edge tab (`openDirect`)
// carries the route's standing scope only, with no citation and no draft.
// Which panels are open is the dock's (the gesture law, MP-3-4); this file
// never opens anything.

import type {
  AssistantChat,
  AssistantCitation,
  AssistantMessage,
  AssistantPage,
} from '@launchastro/ui';
import type { ScopeInput } from './subject.ts';

export interface Chat extends AssistantChat {
  readonly conversationId: string | null;
}

export type StandingScope = Pick<ScopeInput, 'client' | 'task'>;

export interface AssistantState {
  readonly chats: readonly Chat[];
  readonly selected: string;
  /** The next tab's number, so two tabs never share one. */
  readonly next: number;
  readonly citation: AssistantCitation | null;
  readonly draft: string;
  /** Scope the last ask carried; none means the route's own. */
  readonly scope: StandingScope;
}

export interface AskEntry {
  /** The register row the entry point is (AG-K7, CL-M03 and the rest). */
  readonly row: string;
  readonly widget: { readonly id: string; readonly label: string };
  readonly question: string;
  readonly scope: StandingScope;
}

export const FRESH_NOTE = 'Fresh conversation — nothing carried over.';
export const TAB_TITLE_LIMIT = 40;

const NO_SCOPE: StandingScope = { client: null, task: null };

const blank = (number: number, messages: Chat['messages']): Chat => ({
  key: `chat-${number}`,
  conversationId: null,
  title: `Chat ${number}`,
  model: null,
  page: null,
  messages,
});

export const initial = (): AssistantState => ({
  chats: [blank(1, [])],
  selected: 'chat-1',
  next: 2,
  citation: null,
  draft: '',
  scope: NO_SCOPE,
});

export function fresh(state: AssistantState): AssistantState {
  const chat = blank(state.next, [{ id: 'fresh', role: 'note', body: FRESH_NOTE, cites: [] }]);
  return {
    ...state,
    chats: [...state.chats, chat],
    selected: chat.key,
    next: state.next + 1,
    citation: null,
    draft: '',
  };
}

const has = (state: AssistantState, key: string): boolean =>
  state.chats.some((chat) => chat.key === key);

function change(state: AssistantState, key: string, edit: (chat: Chat) => Chat): AssistantState {
  if (!has(state, key)) return state;
  return { ...state, chats: state.chats.map((chat) => (chat.key === key ? edit(chat) : chat)) };
}

export const select = (state: AssistantState, key: string): AssistantState =>
  has(state, key) && state.selected !== key ? { ...state, selected: key } : state;

export function rename(state: AssistantState, key: string, title: string): AssistantState {
  const trimmed = title.trim().slice(0, TAB_TITLE_LIMIT);
  if (trimmed === '') return state;
  return change(state, key, (chat) => ({ ...chat, title: trimmed }));
}

export function takeOut(state: AssistantState, key: string): AssistantState {
  const at = state.chats.findIndex((chat) => chat.key === key);
  if (at === -1) return state;
  const chats = state.chats.filter((chat) => chat.key !== key);
  if (chats.length === 0) return fresh({ ...state, chats });
  const selected =
    state.selected === key ? (chats[Math.max(0, at - 1)]?.key ?? '') : state.selected;
  return { ...state, chats, selected };
}

export const chooseModel = (state: AssistantState, key: string, model: string): AssistantState =>
  change(state, key, (chat) => ({ ...chat, model }));

/** The page in scope; a second one replaces the first, and its note with it. */
export const addPage = (state: AssistantState, key: string, page: AssistantPage): AssistantState =>
  change(state, key, (chat) => ({
    ...chat,
    page,
    messages: [
      ...chat.messages.filter((message) => message.id !== 'page'),
      {
        id: 'page',
        role: 'note',
        body: `Read this page into context — every widget on ${page.address}, and nothing else.`,
        cites: [],
      },
    ],
  }));

export function ask(state: AssistantState, entry: AskEntry): AssistantState {
  const question = entry.question.trim();
  if (question === '' || entry.widget.id === '' || entry.widget.label.trim() === '') return state;
  return {
    ...fresh(state),
    citation: { row: entry.row, id: entry.widget.id, label: entry.widget.label },
    draft: question,
    scope: entry.scope,
  };
}

export const openDirect = (state: AssistantState): AssistantState => ({
  ...state,
  citation: null,
  draft: '',
  scope: NO_SCOPE,
});

/** A line added to a tab's transcript. */
export const said = (
  state: AssistantState,
  key: string,
  message: AssistantMessage,
): AssistantState =>
  change(state, key, (chat) => ({ ...chat, messages: [...chat.messages, message] }));

/** The tab's first question started its conversation. */
export const started = (
  state: AssistantState,
  key: string,
  conversationId: string,
): AssistantState => change(state, key, (chat) => ({ ...chat, conversationId }));
