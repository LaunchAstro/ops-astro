// SPDX-License-Identifier: AGPL-3.0-only
//
// An offer judgement that waits on a lock before the database rings the
// doorbell delays the agent's accept. On identical clocks that wait is not
// clock skew: the answer that follows is still fresh and is taken.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { agentTopic, parseCarryKeys } from '../../packages/core-custody/src/agent.ts';
import type { Handoff } from '../../packages/core-custody/src/carriage.ts';
import { carriedCustody } from '../../packages/core-custody/src/carried-custody.ts';
import { openAgentWorld, chatRequest } from './model-agent-world.ts';

// oxlint-disable-next-line max-lines-per-function -- one world, a control call and the waiting call
it('an offer judgement wait does not expire fresh answers on identical clocks', async () => {
  const now = Date.now;
  const world = await openAgentWorld({ now });
  const parsed = parseCarryKeys(world.key);
  if (!parsed.ok) throw new Error('invalid test key');
  const bell = await world.carriage.join(agentTopic(world.business, world.agentId), 'database');
  if (!bell.ok) throw new Error('doorbell refused');
  const custody = carriedCustody({
    carriage: world.carriage,
    keys: parsed.keys,
    key: world.key,
    now,
  });
  const handoff = (wait: number): Handoff => {
    const callId = randomUUID();
    return {
      businessId: world.business,
      callId,
      accessToken: 'person-token',
      offer: async () => {
        // The offer judgement waits for a lock before the database commits its
        // notification. Both participants and custody use the real host clock.
        await sleep(wait);
        await bell.line.send('offer', { c: randomUUID(), k: callId });
        return { ok: true };
      },
      fence: async () => await Promise.resolve({ ok: true, release: async () => {} }),
    };
  };
  try {
    const control = await custody.dispatch(
      'ollama_key',
      chatRequest(),
      undefined,
      undefined,
      handoff(0),
    );
    expect(control.kind).toBe('answered');
    const delayed = await custody.dispatch(
      'ollama_key',
      chatRequest(),
      undefined,
      undefined,
      handoff(31_000),
    );
    expect(world.ollama.seen).toHaveLength(2);
    expect(
      delayed.kind,
      'Ollama answered, but offer lock latency was mistaken for clock skew',
    ).toBe('answered');
  } finally {
    await bell.line.leave();
    await custody.stop();
    await world.close();
  }
}, 45_000);
