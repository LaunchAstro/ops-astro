// SPDX-License-Identifier: AGPL-3.0-only
//
// With the owner's ChatGPT plan set, the model agent asks custody to prepare
// the plan's token before it accepts a call (#1620 P4): an offer is ids only,
// so the agent cannot yet tell a plan call from any other. Its accept is
// stamped after the prepare, so the send window still runs from the accept.
// A prepare that refuses still accepts (the plan call is refused later, at
// `present()`, with nothing sent). A prepare inside its 30 s bound accepts; one
// past it accepts nothing, and custody is handed nothing. Without the plan,
// nothing is prepared. The clock here is a fake one: no case waits 30 s.

import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCEPT_WINDOW_MS,
  PLAN_ACCEPT_WINDOW_MS,
  PLAN_PREPARE_MS,
  SEND_WINDOW_MS,
  agentTopic,
  callTopic,
  parseCarryKeys,
} from '../../packages/core-custody/src/agent.ts';
import { PREPARE_BOUND_MS } from '../../packages/core-custody/src/plan-token.ts';
import { agentCustody } from '../../apps/model-agent/main.ts';
import {
  startModelAgent,
  type AgentCustody,
  type ModelAgent,
} from '../../apps/model-agent/carrier.ts';
import { memoryCarriage, type MemoryCarriage } from '../support/memory-carriage.ts';

/** A turn of the real event loop, which the fake clock leaves alone. */
const turn = async (): Promise<void> =>
  await new Promise((done) => {
    setImmediate(done);
  });

/** A prepare the case answers by hand. */
function byHand(): { readonly prepare: () => Promise<{ ok: true }>; readonly answer: () => void } {
  const box: { answer?: (value: { ok: true }) => void } = {};
  const prepare = async (): Promise<{ ok: true }> =>
    await new Promise((done) => {
      box.answer = done;
    });
  return { prepare, answer: () => box.answer?.({ ok: true }) };
}

interface Bench {
  readonly carriage: MemoryCarriage;
  readonly agent: ModelAgent;
  readonly logs: string[];
  readonly handed: unknown[];
  /** Rings one offer; resolves once the agent has asked to prepare or accepted. */
  offer(): Promise<string>;
  accepts(): number;
}

let bench: Bench | undefined;
afterEach(async () => {
  await bench?.agent.stop();
  bench = undefined;
  vi.useRealTimers();
});

async function open(prepare?: AgentCustody['prepare']): Promise<Bench> {
  const key = randomBytes(32).toString('base64url');
  const parsed = parseCarryKeys(key);
  if (!parsed.ok) throw new Error('the case made a malformed carry key');
  const carriage = memoryCarriage();
  const business = randomUUID();
  const agentId = randomUUID();
  const logs: string[] = [];
  const handed: unknown[] = [];
  const custody: AgentCustody = {
    dispatch: async (request) => {
      handed.push(request);
      return await Promise.resolve({ kind: 'refused', started: false, code: 'X' });
    },
    ...(prepare === undefined ? {} : { prepare }),
  };
  const started = await startModelAgent({
    carriage,
    keys: parsed.keys,
    key,
    business,
    agent: agentId,
    token: async () => await Promise.resolve('agent-token'),
    custody,
    log: (kind) => logs.push(kind),
  });
  if ('because' in started) throw new Error(started.because);
  const bell = await carriage.join(agentTopic(business, agentId), 'database');
  if (!bell.ok) throw new Error('the doorbell could not be joined');
  const accepts = (): number => carriage.said.filter((said) => said.event === 'accept').length;
  return {
    carriage,
    agent: started,
    logs,
    handed,
    accepts,
    offer: async () => {
      const k = randomUUID();
      await carriage.join(callTopic(business, k), 'person-token');
      await bell.line.send('offer', { c: randomUUID(), k });
      for (let at = 0; at < 50 && !logs.includes('offer'); at += 1) await turn(); // oxlint-disable-line no-await-in-loop
      for (let at = 0; at < 10; at += 1) await turn(); // oxlint-disable-line no-await-in-loop
      return k;
    },
  };
}

describe('the plan’s windows', () => {
  it('the agent’s prepare bound is the holder’s, and only a plan call waits for it', () => {
    expect(PLAN_PREPARE_MS).toBe(PREPARE_BOUND_MS);
    expect(PLAN_PREPARE_MS).toBe(30_000);
    expect(ACCEPT_WINDOW_MS).toBe(5_000);
    expect(PLAN_ACCEPT_WINDOW_MS).toBe(35_000);
    expect(SEND_WINDOW_MS).toBe(3_000);
  });
});

/** Ten turns of the real event loop, for messages a turn away. */
async function turns(): Promise<void> {
  for (let at = 0; at < 10; at += 1) await turn(); // oxlint-disable-line no-await-in-loop
}

// oxlint-disable-next-line max-lines-per-function -- the four ways a prepare ends, side by side
describe('with the plan set, the agent prepares before it accepts', () => {
  it('sends no accept until the prepare answers, then accepts, stamped after it', async () => {
    const hand = byHand();
    const prepare = vi.fn(hand.prepare);
    bench = await open(prepare);
    await bench.offer();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(bench.accepts()).toBe(0);
    const preparedAt = Date.now();
    hand.answer();
    await turns();
    expect(bench.accepts()).toBe(1);
    const accept = bench.carriage.said.find((said) => said.event === 'accept');
    const sealed = accept?.message as { body: string };
    const { acceptedAt } = JSON.parse(sealed.body) as { acceptedAt: number };
    expect(acceptedAt).toBeGreaterThanOrEqual(preparedAt);
  });

  it('a prepare that refuses still accepts', async () => {
    bench = await open(
      async () => await Promise.resolve({ ok: false, code: 'SUBSCRIPTION_SIGN_IN_NEEDED' }),
    );
    await bench.offer();
    expect(bench.accepts()).toBe(1);
  });

  it('a prepare that takes 29 s of its 30 s bound still accepts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    bench = await open(
      async () =>
        await new Promise((done) => {
          setTimeout(() => done({ ok: true }), 29_000);
        }),
    );
    await bench.offer();
    expect(bench.accepts()).toBe(0);
    await vi.advanceTimersByTimeAsync(29_000);
    await turns();
    expect(bench.accepts()).toBe(1);
  });

  it('a prepare past its 30 s bound accepts nothing, and custody is handed nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const hand = byHand();
    bench = await open(hand.prepare);
    await bench.offer();
    await vi.advanceTimersByTimeAsync(PREPARE_BOUND_MS);
    await turns();
    expect(bench.accepts()).toBe(0);
    expect(bench.logs).toContain('prepare lapsed');
    // A prepare that answers after its bound changes nothing.
    hand.answer();
    await turns();
    expect(bench.accepts()).toBe(0);
    expect(bench.handed).toStrictEqual([]);
  });
});

describe('without the plan', () => {
  it('the agent’s custody has no prepare, and the agent accepts at once', async () => {
    const prepare = vi.fn(async () => await Promise.resolve({ ok: true as const }));
    const custody = { dispatchBefore: vi.fn(), prepare };
    const mapped = agentCustody({ credentialRef: 'ollama_key' }, custody as never);
    expect(mapped.prepare).toBeUndefined();
    const planned = agentCustody(
      { credentialRef: 'ollama_key', planTokenFile: '/x/plan.json' },
      custody as never,
    );
    await planned.prepare?.();
    expect(prepare).toHaveBeenCalledTimes(1);
    bench = await open();
    await bench.offer();
    expect(bench.accepts()).toBe(1);
  });
});
