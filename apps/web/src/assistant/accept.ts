// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04: a plan card's one click. The card goes in flight, `task.accept_plan`
// is sent with the version on screen and the words the card showed, and the
// answer settles the card: approved once the server kept the words, stale on
// a stale version (a ceiling that is not the version's among them), or offered
// again, the server's refusal quoted as it came either way. Nothing else in
// the drawer moves, and nothing is retried.
//
// Cards that send one body share one operation id, kept while any of them is
// in flight or has lost its answer, so a click after an unknown outcome
// replays a committed accept (operations/client.ts). Each card has its own
// place in that attempt: an answer settles the attempt its click sent under,
// never one that took the same body later. The server's yes is every lost
// card's too; a refusal lets its own card go; once no card is left, the next
// click mints a new id. A card that lost its answer stays `unknown`, its
// accept kept, even once a newer version lands.

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
 * Each accept still owed an answer, by session and by the whole body the
 * register digests: two cards that send one body are one accept, and two tabs'
 * cards (each its conversation) are two. `cards` holds each card that sent it
 * and has no known answer yet.
 */
interface Attempt {
  readonly operationId: string;
  readonly cards: Map<string, 'pending' | 'unknown'>;
}

const attempts = new Map<string, Attempt>();

/**
 * The register's canonical form (core-digest, which loads node:crypto, so
 * copied here): keys sorted at every depth, undefined members dropped, arrays
 * in order. Two cards whose steps arrive in another key order send one body.
 */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map((member) => canonical(member))
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, member]) => member !== undefined)
            .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, member]) => [key, canonical(member)]),
        )
      : value;

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
  const held = JSON.stringify([grantKey ?? null, canonical(body)]);
  const attempt = attempts.get(held) ?? { operationId: client.newOperationId(), cards: new Map() };
  attempts.set(held, attempt);
  attempt.cards.set(id, 'pending');
  const { operationId } = attempt;
  const settled = settle(await client.mutate('task.accept_plan', body, { operationId }));
  if (settled.kind === 'unknown') attempt.cards.set(id, 'unknown');
  else attempt.cards.delete(id);
  // The server kept this accept once: each card that lost its answer to it was kept too.
  const kept = settled.kind === 'ok' ? [...attempt.cards].filter(([, at]) => at === 'unknown') : [];
  for (const [other] of kept) attempt.cards.delete(other);
  if (attempt.cards.size === 0 && attempts.get(held) === attempt) attempts.delete(held);
  store.update((current) =>
    kept.reduce(
      (state, [other]) => settlePlan(state, key, other, { state: 'approved', refusal: null }),
      settlePlan(current, key, id, {
        state: SETTLED[settled.kind],
        refusal: settled.kind === 'ok' ? null : settled.because,
      }),
    ),
  );
}
