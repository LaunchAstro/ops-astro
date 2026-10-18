// SPDX-License-Identifier: AGPL-3.0-only
//
// The function learns the agent's clock from the instant the agent joined the
// call's line, which its sealed accept carries beside the accept's own stamp
// (#1620 P4: the plan's prepare comes between the two). A join stamp that is
// not a whole number, comes after the accept, or sits further before it than
// the prepare's bound is refused as the machine being away, before the fence:
// nothing is sent. An accept with no join stamp is an agent with no prepare.

import { randomBytes, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  PLAN_PREPARE_MS,
  SEAL_LIFE_MS,
  callTopic,
  parseCarryKeys,
  sealed,
} from '../../packages/core-custody/src/agent.ts';
import type { Handoff } from '../../packages/core-custody/src/carriage.ts';
import { carriedCustody } from '../../packages/core-custody/src/carried-custody.ts';
import { memoryCarriage } from '../support/memory-carriage.ts';
import { planRequest } from './fixtures/plan-route-world.ts';

/** One plan call whose agent accepts with `body`; whether the fence was reached, and the outcome. */
async function acceptedWith(body: (now: number) => Record<string, unknown>) {
  const key = randomBytes(32).toString('base64url');
  const parsed = parseCarryKeys(key);
  if (!parsed.ok) throw new Error('invalid test key');
  const carriage = memoryCarriage();
  const business = randomUUID();
  const callId = randomUUID();
  let fenced = false;
  const handoff: Handoff = {
    businessId: business,
    callId,
    accessToken: 'person-token',
    offer: async () => {
      const joined = await carriage.join(callTopic(business, callId), 'agent-token');
      if (!joined.ok) throw new Error('call line refused');
      const now = Date.now();
      const accept = sealed(key, {
        direction: 'agent',
        k: callId,
        runner: randomUUID(),
        event: 'accept',
        seq: 0,
        expiresAt: now + SEAL_LIFE_MS,
        body: JSON.stringify(body(now)),
      });
      await joined.line.send('accept', accept);
      return { ok: true };
    },
    fence: async () => {
      fenced = true;
      return await Promise.resolve({ ok: false, code: 'CALL_NOT_DISPATCHED' });
    },
  };
  const custody = carriedCustody({ carriage, keys: parsed.keys, key });
  const outcome = await custody.dispatch(
    'chatgpt_plan',
    planRequest(),
    undefined,
    undefined,
    handoff,
  );
  const requests = carriage.said.filter((said) => said.event === 'request');
  return { outcome, fenced, requests };
}

const AWAY = { kind: 'refused', started: false, code: 'MODEL_MACHINE_AWAY' };

it.each([
  ['after the accept', (now: number) => ({ acceptedAt: now, joinedAt: now + 1 })],
  [
    'further before the accept than the prepare bound',
    (now: number) => ({ acceptedAt: now, joinedAt: now - PLAN_PREPARE_MS - 1 }),
  ],
  ['a string', (now: number) => ({ acceptedAt: now, joinedAt: String(now) })],
  ['a fraction', (now: number) => ({ acceptedAt: now, joinedAt: now - 0.5 })],
  ['null', (now: number) => ({ acceptedAt: now, joinedAt: null })],
])(
  'an accept whose join stamp is %s is refused before the fence, nothing sent',
  async (_, body) => {
    const { outcome, fenced, requests } = await acceptedWith(body);
    expect(outcome).toStrictEqual(AWAY);
    expect(fenced).toBe(false);
    expect(requests).toStrictEqual([]);
  },
);

it.each([
  ['inside the prepare bound', (now: number) => ({ acceptedAt: now, joinedAt: now - 20_000 })],
  ['absent, an agent with no prepare', (now: number) => ({ acceptedAt: now })],
])('an accept whose join stamp is %s reaches the fence', async (_, body) => {
  const { fenced } = await acceptedWith(body);
  expect(fenced).toBe(true);
});
