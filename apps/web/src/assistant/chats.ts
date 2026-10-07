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
  PlanCardState,
} from '@launchastro/ui';
import type { ScopeInput } from './subject.ts';

export type StandingScope = Pick<ScopeInput, 'client' | 'task'>;

export interface Chat extends AssistantChat {
  readonly conversationId: string | null;
  /** The scope this conversation was asked under: selecting it brings it back. */
  readonly scope: StandingScope;
}

export interface AssistantState {
  readonly chats: readonly Chat[];
  readonly selected: string;
  /** The next tab's number, so two tabs never share one. */
  readonly next: number;
  readonly citation: AssistantCitation | null;
  readonly draft: string;
  /** The selected conversation's scope; none means the route's own. */
  readonly scope: StandingScope;
  /** Each tab's questions still out, by key: a tab with one out is answering. */
  readonly answering: Readonly<Record<string, number>>;
  /** A tab folded into another (`started`), by key: what still lands for it lands there. */
  readonly folded: Readonly<Record<string, string>>;
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

const blank = (number: number, messages: Chat['messages'], scope: StandingScope): Chat => ({
  key: `chat-${number}`,
  conversationId: null,
  title: `Chat ${number}`,
  model: null,
  page: null,
  messages,
  scope,
});

export const initial = (): AssistantState => ({
  chats: [blank(1, [], NO_SCOPE)],
  selected: 'chat-1',
  next: 2,
  citation: null,
  draft: '',
  scope: NO_SCOPE,
  answering: {},
  folded: {},
});

export function fresh(state: AssistantState): AssistantState {
  const note: AssistantMessage = { id: 'fresh', role: 'note', body: FRESH_NOTE, cites: [] };
  const chat = blank(state.next, [note], state.scope);
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

/** The tab `key` selected, with the scope its conversation was asked under. */
function selecting(state: AssistantState, key: string): AssistantState {
  const scope = state.chats.find((chat) => chat.key === key)?.scope ?? NO_SCOPE;
  return { ...state, selected: key, scope };
}

export const select = (state: AssistantState, key: string): AssistantState =>
  has(state, key) && state.selected !== key ? selecting(state, key) : state;

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
  if (state.selected !== key) return { ...state, chats };
  return selecting({ ...state, chats }, chats[Math.max(0, at - 1)]?.key ?? '');
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
    ...fresh({ ...state, scope: entry.scope }),
    citation: { row: entry.row, id: entry.widget.id, label: entry.widget.label },
    draft: question,
  };
}

export const openDirect = (state: AssistantState): AssistantState => ({
  ...state,
  citation: null,
  draft: '',
  scope: NO_SCOPE,
  answering: {},
});

/** A line added to a tab's transcript. */
export const said = (
  state: AssistantState,
  key: string,
  message: AssistantMessage,
): AssistantState =>
  change(state, key, (chat) => ({ ...chat, messages: [...chat.messages, message] }));

/** A line `conversation.read` gave a tab carries this before the server's id. */
export const READ_LINE = 'kept-';

/** The tab a line for `key` lands in: `key`, or the tab it was folded into. */
export const keyIn = (state: AssistantState, key: string): string => state.folded[key] ?? key;

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
 * The tab's first question started its conversation. A tab the history
 * reopened for that same conversation while the start was out folds into it,
 * so it is never open twice. What its read gave is the start's own question,
 * already here; what was asked and answered there since follows, each plan
 * version there replacing the older ones here; its questions still out are
 * this tab's, and a line still on its way to it lands here.
 */
export function started(
  state: AssistantState,
  key: string,
  conversationId: string,
): AssistantState {
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
    messages: since.reduce<readonly AssistantMessage[]>(
      (lines, line) => [
        ...(line.plan === undefined ? lines : replaced(lines, line.plan.version)),
        line,
      ],
      chat.messages,
    ),
  }));
}

/** A question for tab `key` (or the tab it was folded into) went out (+1) or came back (-1). */
export function asking(state: AssistantState, key: string, by: 1 | -1): AssistantState {
  const into = keyIn(state, key);
  return {
    ...state,
    answering: { ...state.answering, [into]: Math.max(0, (state.answering[into] ?? 0) + by) },
  };
}

/** A conversation as `conversation.read` gave it: its id, title and transcript. */
export interface Reopened {
  readonly conversationId: string;
  readonly title: string;
  readonly messages: Chat['messages'];
}

/**
 * Tabs for conversations kept or reopened (CS-7.33, C36): a conversation
 * already open is selected, never opened twice; the rest open after the tabs
 * there are, the last one selected.
 */
export function reopened(
  state: AssistantState,
  conversations: readonly Reopened[],
): AssistantState {
  let next = state;
  for (const one of conversations) {
    const open = next.chats.find((chat) => chat.conversationId === one.conversationId);
    if (open !== undefined) {
      next = selecting(next, open.key);
      continue;
    }
    const chat = { ...blank(next.next, one.messages, NO_SCOPE), ...one, key: `chat-${next.next}` };
    next = selecting({ ...next, chats: [...next.chats, chat], next: next.next + 1 }, chat.key);
  }
  return next;
}

/**
 * Kept tab `key`'s transcript and title, as its conversation's read gave them:
 * the title only while the tab still shows `placeholder`, so a rename made
 * while the read was out stands, and the transcript ahead of any line added
 * since. A tab closed meanwhile takes nothing, nor does another tab open on
 * that conversation.
 */
export const transcript = (
  state: AssistantState,
  key: string,
  read: Pick<Chat, 'messages'> & { readonly title?: string },
  placeholder: string,
): AssistantState =>
  change(state, key, (chat) => ({
    ...chat,
    title: chat.title === placeholder ? (read.title ?? chat.title) : chat.title,
    messages: [...read.messages, ...chat.messages],
  }));
