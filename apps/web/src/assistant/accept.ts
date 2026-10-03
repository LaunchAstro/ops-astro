// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04: a plan card's one click. The card goes in flight, `task.accept_plan`
// is sent with the version on screen and the words the card showed, and the
// answer settles the card: approved once the server kept the words, stale on
// a stale version (a ceiling that is not the version's among them), or offered
// again, the server's refusal quoted as it came either way. Nothing else in
// the drawer moves, and nothing is retried. A click after an unknown outcome
// reuses the operation id kept for that body in that session, from any card
// that sends it, so a committed accept replays (operations/client.ts); a
// settled answer ends the attempt, except OPERATION_ID_REUSED, which says the
// id is spent under another body. That card stays `unknown`, its accept kept,
// even once a newer version lands.

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

/**
 * The operation id of each attempt whose outcome is still unknown, by session
 * and by the whole body the register digests: two cards that send one body
 * are one accept, and two tabs' cards (each its conversation) are two.
 */
const attempts = new Map<string, string>();

/** A stale version can never be accepted, so its card offers no click; other refusals do. */
const SETTLED = {
  ok: 'approved',
  unknown: 'unknown',
  stale: 'stale',
  closed: 'offered',
  failed: 'offered',
} as const;

export async function acceptPlanCard(
  view: { readonly client: OperationsClient; readonly grantKey?: string },
  store: CardStore,
  card: { readonly key: string; readonly id: string },
): Promise<void> {
  const { client, grantKey } = view;
  const { key, id } = card;
  const offer = store.offer(id);
  if (offer === undefined) return;
  store.update((current) => settlePlan(current, key, id, { state: 'accepting', refusal: null }));
  const conversationId = store.chat(key)?.conversationId ?? null;
  const body = acceptBody(offer, conversationId);
  const attempt = JSON.stringify([grantKey ?? null, body]);
  const operationId = attempts.get(attempt) ?? client.newOperationId();
  attempts.set(attempt, operationId);
  const settled = settle(await client.mutate('task.accept_plan', body, { operationId }));
  const spent = settled.kind === 'failed' && settled.refusal.code === 'OPERATION_ID_REUSED';
  if (settled.kind !== 'unknown' && !spent) attempts.delete(attempt);
  store.update((current) =>
    settlePlan(current, key, id, {
      state: SETTLED[settled.kind],
      refusal: settled.kind === 'ok' ? null : settled.because,
    }),
  );
}
