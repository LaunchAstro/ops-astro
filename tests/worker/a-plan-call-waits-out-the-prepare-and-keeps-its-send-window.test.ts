// SPDX-License-Identifier: AGPL-3.0-only
//
// The function's side of the plan's prepare (#1620 P4). The carried custody
// waits for a plan call's accept for the accept window plus the prepare's
// bound (35 s), so an accept that comes after a slow prepare is still taken,
// and the request it sends must still be written by the accept plus W (3 s).
// Any other call keeps its 5 s accept window: an Ollama call whose accept
// waits on a slow prepare is released, and nothing is sent. The prepare here
// takes 6 s, past the 5 s window and well inside 35 s. The agent's clock is
// learnt from when it joined the call's line, before the prepare, so the
// function's seals are good on that clock for one seal's life, never that
// plus the prepare.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import {
  SEAL_LIFE_MS,
  SEND_WINDOW_MS,
  agentTopic,
  parseCarryKeys,
  type OutboundRequest,
} from '../../packages/core-custody/src/agent.ts';
import type { Handoff } from '../../packages/core-custody/src/carriage.ts';
import { carriedCustody } from '../../packages/core-custody/src/carried-custody.ts';
import type { CustodyOutcome } from '../../packages/core-custody/src/custody.ts';
import { planRequest } from '../custody/fixtures/plan-route-world.ts';
import { chatRequest, openAgentWorld, type AgentWorld } from './model-agent-world.ts';

const SLOW_PREPARE_MS = 6_000;

let world: AgentWorld | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

interface Seen {
  preparedAt?: number;
  deadlineAt?: number;
  acceptedAt?: number;
  /** The function's request seal's expiry, on the agent's clock. */
  requestExpiresAt?: number;
}

/** One call carried by the function's custody to an agent whose prepare takes 6 s. */
// oxlint-disable-next-line max-lines-per-function -- the agent's wrapped custody and the function's handoff
async function carriedAfterSlowPrepare(request: OutboundRequest): Promise<{
  readonly outcome: CustodyOutcome;
  readonly seen: Seen;
}> {
  const seen: Seen = {};
  world = await openAgentWorld({
    wrap: (custody) => ({
      prepare: async () => {
        await sleep(SLOW_PREPARE_MS);
        seen.preparedAt = Date.now();
        return { ok: true };
      },
      // A plan call is written and answered here: the case is the windows, not the plan.
      dispatch: async (asked, gate, onPiece) => {
        if (asked.destination !== 'chatgpt_plan')
          return await custody.dispatch(asked, gate, onPiece);
        seen.deadlineAt = gate.deadlineAt;
        gate.onWritten();
        const outbound = { ok: true, status: 200, body: '{}' } as const;
        return {
          kind: 'answered',
          started: true,
          outbound,
          credentialKind: 'api_key',
          account: null,
        };
      },
    }),
  });
  const parsed = parseCarryKeys(world.key);
  if (!parsed.ok) throw new Error('invalid test key');
  const bell = await world.carriage.join(agentTopic(world.business, world.agentId), 'database');
  if (!bell.ok) throw new Error('doorbell refused');
  const custody = carriedCustody({ carriage: world.carriage, keys: parsed.keys, key: world.key });
  const callId = randomUUID();
  const handoff: Handoff = {
    businessId: world.business,
    callId,
    accessToken: 'person-token',
    offer: async () => {
      await bell.line.send('offer', { c: randomUUID(), k: callId });
      return { ok: true };
    },
    fence: async (accept) => {
      seen.acceptedAt = accept.acceptedAt;
      return await Promise.resolve({ ok: true, release: async () => {} });
    },
  };
  try {
    const outcome = await custody.dispatch('ollama_key', request, undefined, undefined, handoff);
    const sent = world.carriage.said.find((said) => said.event === 'request');
    const expiresAt = (sent?.message as { expiresAt?: unknown } | undefined)?.expiresAt;
    if (typeof expiresAt === 'number') seen.requestExpiresAt = expiresAt;
    return { outcome, seen };
  } finally {
    await bell.line.leave();
  }
}

it('a plan call accepted after a 6 s prepare is taken, and its request is due by the accept plus 3 s', async () => {
  const { outcome, seen } = await carriedAfterSlowPrepare(planRequest());
  expect(outcome.kind).toBe('answered');
  expect(seen.acceptedAt).toBeGreaterThanOrEqual(seen.preparedAt ?? Number.POSITIVE_INFINITY);
  expect((seen.deadlineAt ?? 0) - (seen.acceptedAt ?? 0)).toBe(SEND_WINDOW_MS);
}, 15_000);

it("after a 6 s prepare, the function's request seal is good for one seal's life past the accept, not that plus the prepare", async () => {
  const { outcome, seen } = await carriedAfterSlowPrepare(planRequest());
  expect(outcome.kind).toBe('answered');
  const life = (seen.requestExpiresAt ?? Number.POSITIVE_INFINITY) - (seen.acceptedAt ?? 0);
  expect(life).toBeLessThanOrEqual(SEAL_LIFE_MS + 1_000);
}, 15_000);

it('an Ollama call whose accept waits on a 6 s prepare keeps its 5 s window: released, nothing sent', async () => {
  const { outcome } = await carriedAfterSlowPrepare(chatRequest());
  expect(outcome).toStrictEqual({ kind: 'refused', started: false, code: 'MODEL_MACHINE_AWAY' });
  expect(world?.handed).toStrictEqual([]);
  expect(world?.ollama.seen).toHaveLength(0);
}, 15_000);
