// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04: the plan cards in a tab, as pure moves over the drawer's state.
//
// A planning reply that carries a plan adds a card; any card the same tab
// still offers becomes stale, because a changed plan is a new version that
// resets approvals, and only the version on screen may be accepted. A reply
// that drops composes no plan version, so it adds no card (the drawer draws
// its words as a failed line). The click's answer settles the one card: kept
// words make it the approved card, a refusal offers the click again with the
// server's words. A committed accept is approved even if a newer version made
// the card stale meanwhile: the server kept those words and started that run.

import { useRef } from 'react';
import type { AssistantPlan, PlanCardState } from '@launchastro/ui';
import type { PlanOffer } from '../../../../packages/core-wire/src/index.ts';
import { pathTo } from '../routes.ts';
import type { AssistantState, Chat } from './chats.ts';

function change(state: AssistantState, key: string, edit: (chat: Chat) => Chat): AssistantState {
  return { ...state, chats: state.chats.map((chat) => (chat.key === key ? edit(chat) : chat)) };
}

/** The card a plan version draws, offered: every field the accept binds. */
export function cardOf(offer: PlanOffer): AssistantPlan {
  const titleOf = (key: string): string =>
    offer.steps.find((step) => step.key === key)?.title ?? key;
  return {
    version: offer.version,
    text: offer.text,
    steps: offer.steps.map((step) => ({ title: step.title, after: step.after.map(titleOf) })),
    entryPath: offer.entryPath,
    paths: offer.paths,
    ceilingMinor: offer.ceilingMinor,
    spendMinor: offer.planningSpendMinor,
    currency: offer.currency,
    state: 'offered',
    replacedBy: null,
    refusal: null,
    task: { label: offer.task.title, href: pathTo('agency:task-detail', { key: offer.task.key }) },
  };
}

/** A planning reply's plan, as the tab's newest card; older offered cards go stale. */
export function offerPlan(
  state: AssistantState,
  key: string,
  message: { readonly id: string; readonly body: string; readonly offer: PlanOffer },
): AssistantState {
  const card = cardOf(message.offer);
  return change(state, key, (chat) => ({
    ...chat,
    messages: [
      ...chat.messages.map((each) =>
        each.plan !== undefined && each.plan.state !== 'approved'
          ? { ...each, plan: { ...each.plan, state: 'stale' as const, replacedBy: card.version } }
          : each,
      ),
      { id: message.id, role: 'plan', body: message.body, cites: [], plan: card },
    ],
  }));
}

/** One card's click, in flight or answered. */
export function settlePlan(
  state: AssistantState,
  key: string,
  id: string,
  settled: { readonly state: PlanCardState; readonly refusal: string | null },
): AssistantState {
  return change(state, key, (chat) => ({
    ...chat,
    messages: chat.messages.map((each) =>
      each.id === id &&
      each.plan !== undefined &&
      (each.plan.state !== 'stale' || settled.state === 'approved')
        ? { ...each, plan: { ...each.plan, ...settled } }
        : each,
    ),
  }));
}

/** The accept's body: the version on screen and everything the card showed, ceiling too. */
export const acceptBody = (offer: PlanOffer, conversationId: string | null) => ({
  gateId: offer.gateId,
  versionId: offer.versionId,
  note: 'Accepted in the drawer.',
  planText: offer.text,
  plan: { steps: offer.steps },
  entryPath: offer.entryPath,
  paths: offer.paths,
  ceilingMinor: offer.ceilingMinor,
  currency: offer.currency,
  conversationId,
});

/**
 * The drawer's plan cards: a reply's plan as the tab's newest card, its offer
 * kept by the card's id for the one click. `count` is the drawer's own line
 * counter, so a card's id is never another line's.
 */
export function usePlanCards(
  update: (move: (state: AssistantState) => AssistantState) => void,
  count: { current: number },
) {
  const offers = useRef(new Map<string, PlanOffer>());
  return {
    plan: (key: string, body: string, offer: PlanOffer): void => {
      count.current += 1;
      const id = `plan-${String(count.current)}`;
      offers.current.set(id, offer);
      update((current) => offerPlan(current, key, { id, body, offer }));
    },
    offer: (id: string): PlanOffer | undefined => offers.current.get(id),
  };
}
