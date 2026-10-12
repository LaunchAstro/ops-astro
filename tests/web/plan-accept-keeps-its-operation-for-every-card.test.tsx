// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// Two cards that send one accept body share one operation id. The id stays
// while any of those cards is still in flight or has lost its answer, so a
// card whose answer was lost sends its accept again under the id the server
// kept and is approved from the replay, whichever card's answer came first.
// A known refusal lets its card go; once no card is left, the next click
// mints a new id. The register stand-in keys each accept by id and whole body
// and decides the gate once, as the server's does.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import type { PlanOffer } from '../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';
import { settle, type Mounted } from '../surfaces/mount.tsx';
import { ask, LOST, openDrawer } from './assistant-attempt-wire.tsx';

afterEach(unmountAll);

const OFFER: PlanOffer = {
  gateId: '66666666-6666-4666-8666-666666666666',
  versionId: '77777777-7777-4777-8777-777777777771',
  version: 1,
  task: { id: '55555555-5555-4555-8555-555555555555', key: 'T-12', title: 'Spring brief' },
  text: 'Draft the brief. Ceiling: $10.00.',
  steps: [{ key: 'draft', title: 'Draft the brief', after: [] }],
  ceilingMinor: 1000,
  currency: 'AUD',
  planningSpendMinor: 12,
  entryPath: 'agents/brief.md',
  paths: [],
};

const ok = (value: Readonly<Record<string, unknown>>) => ({
  ok: true,
  value: { recordId: '', revision: 0, ...value },
});
const refusal = (code: string) => ({ ok: false, refused: true, code, names: [], fixes: [code] });

type Delivery = 'kept' | 'lost' | 'lost before commit' | 'refused';

/** Every reply carries the same plan; each accept is held until the test delivers it. */
function acceptWire() {
  const register = new Map<string, { readonly digest: string; readonly answer: unknown }>();
  const accepts: {
    readonly id: string;
    readonly body: unknown;
    deliver: (how: Delivery) => void;
  }[] = [];
  let decided = false;
  let minted = 0;
  const decide = (id: string, body: unknown): unknown => {
    const digest = JSON.stringify(body);
    const seen = register.get(id);
    if (seen !== undefined)
      return seen.digest === digest ? seen.answer : refusal('OPERATION_ID_REUSED');
    const answer = decided ? refusal('GATE_ALREADY_DECIDED') : ok({ detail: { runId: 'run-1' } });
    decided = true;
    register.set(id, { digest, answer });
    return answer;
  };
  const reply = { answered: true, messageId: 'm-1', body: 'Here is the plan.', plan: OFFER };
  const client = {
    newOperationId: () => `op-${String((minted += 1))}`,
    read: async () => await Promise.resolve({ unavailable: true, because: 'not asked here' }),
    mutate: async (name: string, body: unknown, options?: { readonly operationId?: string }) => {
      if (name === 'conversation.start') {
        return await Promise.resolve(ok({ detail: { conversationId: 'c-1' }, reply }));
      }
      if (name !== 'task.accept_plan') return await Promise.resolve(ok({ reply }));
      const id = options?.operationId ?? client.newOperationId();
      return await new Promise((resolve) => {
        accepts.push({
          id,
          body,
          deliver: (how) => {
            if (how === 'refused') resolve(refusal('FIELD_VALUE_INVALID'));
            else if (how === 'lost before commit') resolve(LOST);
            else resolve(how === 'lost' ? (decide(id, body), LOST) : decide(id, body));
          },
        });
      });
    },
  };
  const deliver = async (at: number, how: Delivery): Promise<void> => {
    accepts[at]?.deliver(how);
    await settle();
    await settle();
  };
  return { client: client as unknown as OperationsClient, accepts, deliver };
}

/** Each card on screen: approved, accepting (in flight), offered (clickable) or gone stale. */
const cards = (page: Mounted): string[] =>
  page.all('[data-plan="card"]').map((card) => {
    if (card.querySelector('[data-plan="approved"]') !== null) return 'approved';
    const button = card.querySelector<HTMLButtonElement>('[data-plan="accept"]');
    if (button === null) return 'stale';
    return button.disabled ? 'accepting' : 'offered';
  });

async function click(page: Mounted, card: number): Promise<void> {
  const drawn = page.all('[data-plan="card"]')[card];
  const button = drawn?.querySelector<HTMLButtonElement>('[data-plan="accept"]');
  if (button === null || button === undefined)
    throw new Error(`card ${String(card)} offers no accept`);
  await act(() => {
    button.click();
  });
}

/** Card A's first accept is lost before commit; a later reply brings card B with the same offer. */
async function twoCardsOneOffer(grantKey: string) {
  const wire = acceptWire();
  const page = await openDrawer(wire.client, grantKey);
  await ask(page, 'Plan the brief');
  await click(page, 0);
  await wire.deliver(0, 'lost before commit');
  await ask(page, 'Plan it again');
  expect(cards(page)).toStrictEqual(['offered', 'offered']);
  return { wire, page };
}

const allOnOneId = (wire: ReturnType<typeof acceptWire>): void => {
  expect(
    wire.accepts.map((each) => each.id),
    'a card whose answer was lost sent its accept under a new id',
  ).toStrictEqual(wire.accepts.map(() => 'op-1'));
};

it("two cards with one offer, A accepted while B is in flight, then B's answer lost: B's click again reuses the id and settles approved", async () => {
  const { wire, page } = await twoCardsOneOffer('grant-a-first');
  await click(page, 0);
  await click(page, 1);
  await wire.deliver(1, 'kept');
  expect(cards(page)).toStrictEqual(['approved', 'accepting']);
  await wire.deliver(2, 'lost');
  expect(cards(page)).toStrictEqual(['approved', 'offered']);
  await click(page, 1);
  await wire.deliver(3, 'kept');
  expect(cards(page)).toStrictEqual(['approved', 'approved']);
  allOnOneId(wire);
  expect(page.text()).not.toContain('GATE_ALREADY_DECIDED');
});

it("two cards with one offer, B's answer lost while A is in flight, then A accepted: both settle approved on the one id", async () => {
  const { wire, page } = await twoCardsOneOffer('grant-b-first');
  await click(page, 0);
  await click(page, 1);
  await wire.deliver(2, 'lost');
  expect(cards(page)).toStrictEqual(['accepting', 'offered']);
  await wire.deliver(1, 'kept');
  expect(cards(page)).toStrictEqual(['approved', 'approved']);
  allOnOneId(wire);
});

it('a card that loses its answer twice and is then refused lets the id go: the next click mints a new one', async () => {
  const wire = acceptWire();
  const page = await openDrawer(wire.client, 'grant-refused');
  await ask(page, 'Plan the brief');
  await click(page, 0);
  await wire.deliver(0, 'lost before commit');
  await click(page, 0);
  await wire.deliver(1, 'lost before commit');
  await click(page, 0);
  await wire.deliver(2, 'refused');
  expect(cards(page)).toStrictEqual(['offered']);
  await click(page, 0);
  await wire.deliver(3, 'kept');
  expect(wire.accepts.map((each) => each.id)).toStrictEqual(['op-1', 'op-1', 'op-1', 'op-2']);
  expect(cards(page)).toStrictEqual(['approved']);
});

it("one card's successful accept keeps the replay id another card with the same accept still needs", async () => {
  const { wire, page } = await twoCardsOneOffer('grant-shared');
  // Both cards are clicked while the kept id is unknown, their answers held.
  await click(page, 0);
  await click(page, 1);
  await wire.deliver(1, 'kept');
  await wire.deliver(2, 'lost');
  expect(cards(page)[1]).toBe('offered');
  await click(page, 1);
  await wire.deliver(3, 'kept');
  expect(wire.accepts[3]?.id, 'the retry sent a new identity').toBe(wire.accepts[0]?.id);
  expect(cards(page)).toStrictEqual(['approved', 'approved']);
  expect(page.text()).not.toContain('GATE_ALREADY_DECIDED');
});
