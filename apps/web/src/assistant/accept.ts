// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04: a plan card's one click. The card goes in flight, `task.accept_plan`
// is sent with the version on screen and the words the card showed, and the
// answer settles the card: approved once the server kept the words, or offered
// again with the server's refusal quoted as it came (a stale version among
// them). Nothing else in the drawer moves, and nothing is retried. A click
// after an unknown outcome reuses the attempt's operation id, so a committed
// accept replays (operations/client.ts); a settled answer ends the attempt.

import type { PlanOffer } from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../operations/client.ts';
import { settle } from '../records/use-command.ts';
import type { AssistantState, Chat } from './chats.ts';
import { acceptBody, settlePlan } from './plans.ts';

/** The drawer's store, as much of it as the click reads and moves. */
export interface CardStore {
  readonly update: (move: (state: AssistantState) => AssistantState) => void;
  readonly chat: (key: string) => Chat | undefined;
  readonly offer: (id: string) => PlanOffer | undefined;
}

/** The operation id of each card's attempt whose outcome is still unknown. */
const attempts = new WeakMap<PlanOffer, string>();

export async function acceptPlanCard(
  client: OperationsClient,
  store: CardStore,
  card: { readonly key: string; readonly id: string },
): Promise<void> {
  const { key, id } = card;
  const offer = store.offer(id);
  if (offer === undefined) return;
  store.update((current) => settlePlan(current, key, id, { state: 'accepting', refusal: null }));
  const conversationId = store.chat(key)?.conversationId ?? null;
  const operationId = attempts.get(offer) ?? client.newOperationId();
  attempts.set(offer, operationId);
  const body = acceptBody(offer, conversationId);
  const settled = settle(await client.mutate('task.accept_plan', body, { operationId }));
  if (settled.kind !== 'unknown') attempts.delete(offer);
  store.update((current) =>
    settlePlan(current, key, id, {
      state: settled.kind === 'ok' ? 'approved' : 'offered',
      refusal: settled.kind === 'ok' ? null : settled.because,
    }),
  );
}
