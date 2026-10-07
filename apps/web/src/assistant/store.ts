// SPDX-License-Identifier: AGPL-3.0-only
//
// The drawer's store (`views/assistant.tsx`): its state, the moves on it, and
// its lines. A line or a plan card given `after` (the question it answers)
// lands after that question and its earlier answers, not below a question
// asked while it was on its way.

import { useRef, useState } from 'react';
import type { AssistantCite, AssistantRole } from '@launchastro/ui';
import type { PlanOffer } from '../../../../packages/core-wire/src/index.ts';
import { initial, said, type AssistantState, type Chat } from './chats.ts';
import { usePlanCards } from './plans.ts';

type Move = (state: AssistantState) => AssistantState;

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
    chat: (key) => latest.current.chats.find((each) => each.key === key),
    line: (key, role, body, after, cites = []) => {
      count.current += 1;
      const id = `${role}-${String(count.current)}`;
      update((current) => placed(said(current, key, { id, role, body, cites }), key, after));
      return id;
    },
    plan: (key, body, offer, after) => {
      cards.plan(key, body, offer);
      update((current) => placed(current, key, after));
    },
    offer: cards.offer,
  };
}
