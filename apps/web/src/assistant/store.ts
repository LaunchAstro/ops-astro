// SPDX-License-Identifier: AGPL-3.0-only
//
// The drawer's store (`views/assistant.tsx`): its state, the moves on it, and
// its lines. A line or a plan card given `after` (the question it answers)
// lands after that question and its earlier answers, not below a question
// asked while it was on its way.

import { useRef, useState } from 'react';
import type { AssistantCite, AssistantRole } from '@launchastro/ui';
import type { PlanOffer } from '../../../../packages/core-wire/src/index.ts';
import { initial, keyIn, said, type AssistantState, type Chat } from './chats.ts';
import { usePlanCards } from './plans.ts';
import {
  baselineOf,
  keepBaseline,
  PROPOSAL_LINE,
  replyLine,
  taskOf,
  type Baseline,
  type ClickView,
} from './proposals.ts';

type Move = (state: AssistantState) => AssistantState;

/** An answered reply: its message id, its words, its targets and its site pages, unchecked until read. */
type Reply = {
  readonly messageId: string;
  readonly body: string;
  readonly targets?: unknown;
  readonly sitePages?: unknown;
};

export interface Store {
  readonly state: AssistantState;
  readonly update: (move: Move) => void;
  /** The state as the last move left it, for a step that resumes after a wait. */
  readonly now: () => AssistantState;
  readonly chat: (key: string) => Chat | undefined;
  readonly line: (
    key: string,
    role: AssistantRole,
    body: string,
    after?: string,
    cites?: readonly AssistantCite[],
  ) => string;
  /**
   * An agent's answer as the tab's newest line: a task proposal it ends in
   * drawn as a card, its line carrying the reply's message id for the click,
   * and an edit in a chat on no task given the reply's targets to pick from.
   */
  readonly answer: (
    key: string,
    reply: Reply,
    after?: string,
    cites?: readonly AssistantCite[],
  ) => void;
  /** A reply's plan as the tab's newest card, and the offer kept for its click. */
  readonly plan: (key: string, body: string, offer: PlanOffer, after?: string) => void;
  readonly offer: (id: string) => PlanOffer | undefined;
}

/** Tab `key`'s newest line, moved to follow the question `after` and its earlier answers. */
function placed(state: AssistantState, key: string, after?: string): AssistantState {
  const chats = state.chats.map((chat) => {
    const { messages } = chat;
    const from = messages.findIndex((each) => each.id === after);
    const to = messages.findIndex((each, at) => at > from && each.role === 'user');
    if (chat.key !== key || from < 0 || to < 0) return chat;
    return { ...chat, messages: messages.slice(0, -1).toSpliced(to, 0, ...messages.slice(-1)) };
  });
  return { ...state, chats };
}

/** The drawer's store, starting from `start` (one fresh tab unless told otherwise). */
export function useStore(start: () => AssistantState = initial): Store {
  const [state, setState] = useState(start);
  const latest = useRef(state);
  const count = useRef(0);
  const update = (move: Move): void => {
    latest.current = move(latest.current);
    setState(latest.current);
  };
  const cards = usePlanCards(update, count);
  return {
    state,
    update,
    now: () => latest.current,
    chat: (key) => latest.current.chats.find((each) => each.key === keyIn(latest.current, key)),
    line: (key, role, body, after, cites = []) => {
      count.current += 1;
      const id = `${role}-${String(count.current)}`;
      const into = keyIn(latest.current, key);
      update((current) =>
        placed(said(current, into, { id, role, body, cites }, after), into, after),
      );
      return id;
    },
    answer: (key, reply, after, cites = []) => {
      const into = keyIn(latest.current, key);
      const chat = latest.current.chats.find((each) => each.key === into);
      const onTask = chat !== undefined && taskOf(chat) !== null;
      const line = replyLine(reply.body, onTask, reply.targets, reply.sitePages);
      count.current += 1;
      const id =
        line.proposal === undefined
          ? `ai-${String(count.current)}`
          : `${PROPOSAL_LINE}${reply.messageId}`;
      update((current) =>
        placed(said(current, into, { id, role: 'ai', cites, ...line }), into, after),
      );
    },
    plan: (key, body, offer, after) => {
      const into = keyIn(latest.current, key);
      cards.plan(into, body, offer);
      update((current) => placed(current, into, after));
    },
    offer: cards.offer,
  };
}

/**
 * The store a question's answers land through, after the question, and the
 * read of the chat's task made before it is sent: the question waits for
 * `read`, and an edit its answer proposes is kept bound to what it read.
 */
export function answersTo(
  view: ClickView,
  store: Store,
  chat: Chat,
  question: string,
): { readonly on: Store; readonly read: Promise<Baseline | null> } {
  let baseline: Baseline | null = null;
  const read = baselineOf(view.client, chat).then((found) => (baseline = found));
  const on: Store = {
    ...store,
    line: (key, role, words, _after, cites) => store.line(key, role, words, question, cites),
    plan: (key, words, offer) => store.plan(key, words, offer, question),
    answer: (key, reply, _after, cites) => {
      keepBaseline(view, reply, baseline);
      store.answer(key, reply, question, cites);
    },
  };
  return { on, read };
}
