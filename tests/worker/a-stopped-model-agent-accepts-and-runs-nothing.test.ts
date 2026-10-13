// SPDX-License-Identifier: AGPL-3.0-only
//
// Once the model agent is stopped it accepts nothing, runs nothing and
// holds no line. An offer heard just before the stop is still joining its
// call's line when `stop` returns; when that join completes, the agent must
// leave the line, not accept on it. Accepting would answer a function with a
// runner that has gone, hand custody a request after the stop, and keep a
// Realtime socket open, so a process told to end would not exit.

import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  agentTopic,
  callTopic,
  deadlineOf,
  parseCarryKeys,
  sealed,
  type Carriage,
  type Line,
  type OutboundRequest,
} from '../../packages/core-custody/src/agent.ts';
import { startModelAgent } from '../../apps/model-agent/carrier.ts';
import { memoryCarriage } from '../support/memory-carriage.ts';
import { carryKey, chatRequest } from './model-agent-world.ts';

const nothing = (): void => {};

/** A promise opened by hand. */
function latch(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open = nothing;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** A few turns of the event loop: what a released join sets going has run by then. */
async function turns(n = 5): Promise<void> {
  for (let at = 0; at < n; at += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one turn after another
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

const lines: Line[] = [];

afterEach(async () => {
  for (const line of lines.splice(0)) await line.leave(); // oxlint-disable-line no-await-in-loop
});

// oxlint-disable-next-line max-lines-per-function -- the held join, the stop and the replay in one case
it('an offer whose join completes after the stop is not accepted, run or kept joined', async () => {
  const key = carryKey();
  const parsed = parseCarryKeys(key);
  if (!parsed.ok) throw new Error('the case made a malformed carry key');
  const memory = memoryCarriage();
  const joining = latch();
  const go = latch();
  // The agent's join of a call's line waits until the case lets it go.
  const carriage: Carriage = {
    join: async (topic, token) => {
      if (token === 'agent-token' && topic.includes(':call:')) {
        joining.open();
        await go.promise;
      }
      return await memory.join(topic, token);
    },
  };
  const handed: OutboundRequest[] = [];
  const business = randomUUID();
  const agentId = randomUUID();
  const agent = await startModelAgent({
    carriage,
    keys: parsed.keys,
    key,
    business,
    agent: agentId,
    token: async () => await Promise.resolve('agent-token'),
    custody: {
      dispatch: async (request) => {
        handed.push(request);
        return await Promise.resolve({ kind: 'refused', started: false, code: 'CASE' });
      },
    },
  });
  if ('because' in agent) throw new Error('the agent did not start');
  const bell = await memory.join(agentTopic(business, agentId), 'database');
  const k = randomUUID();
  const person = await memory.join(callTopic(business, k), 'person-token');
  if (!bell.ok || !person.ok) throw new Error('the case could not join');
  lines.push(bell.line, person.line);

  await bell.line.send('offer', { c: randomUUID(), k });
  await joining.promise;
  await agent.stop();
  go.open();
  await turns();

  const accepts = memory.said.filter((said) => said.event === 'accept');
  // Only the person's own line is joined to the call now.
  const joined = memory.joined().filter((topic) => topic === callTopic(business, k));
  // A request sealed for the stopped runner, as a function that heard an accept would send.
  const said = accepts[0]?.message as { body?: string } | undefined;
  const acceptedAt = Number(
    (JSON.parse(said?.body ?? '{}') as { acceptedAt?: number }).acceptedAt ?? Date.now(),
  );
  await person.line.send(
    'request',
    sealed(key, {
      direction: 'broker',
      k,
      runner: agent.runner,
      event: 'request',
      seq: 0,
      expiresAt: Date.now() + 30_000,
      body: JSON.stringify({ request: chatRequest(), deadlineAt: deadlineOf(acceptedAt) }),
    }),
  );
  await turns();
  expect(accepts).toStrictEqual([]);
  expect(joined).toHaveLength(1);
  expect(handed).toStrictEqual([]);
});
