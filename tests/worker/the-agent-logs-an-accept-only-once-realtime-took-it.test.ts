// SPDX-License-Identifier: AGPL-3.0-only
//
// #1667: a first message got MODEL_MACHINE_AWAY while the model agent's log
// said `offer`, then `accept`. The function never heard that accept, and the
// log could not say whether Realtime had taken it, or when. The agent now logs
// `accept` only once its line reports the accept sent, `accept unsent`
// otherwise, and each line of its log carries the UTC time it was written.

import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  agentTopic,
  callTopic,
  parseCarryKeys,
  type Carriage,
  type Line,
} from '../../packages/core-custody/src/agent.ts';
import { startModelAgent, type ModelAgent } from '../../apps/model-agent/carrier.ts';
import { logLine } from '../../apps/model-agent/main.ts';
import { memoryCarriage } from '../support/memory-carriage.ts';
import { carryKey } from './model-agent-world.ts';

const lines: Line[] = [];
const agents: ModelAgent[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop(); // oxlint-disable-line no-await-in-loop
  for (const line of lines.splice(0)) await line.leave(); // oxlint-disable-line no-await-in-loop
});

/** A few turns of the event loop: what an offer sets going has run by then. */
async function turns(n = 5): Promise<void> {
  for (let at = 0; at < n; at += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one turn after another
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** One offer rung on an agent whose call lines report `sent` as given; what it logged. */
async function offered(sent: 'sent' | 'failed'): Promise<readonly string[]> {
  const parsed = parseCarryKeys(carryKey());
  if (!parsed.ok) throw new Error('the case made a malformed carry key');
  const memory = memoryCarriage();
  // The agent's call lines report each send as the case says; its doorbell is as it was.
  const carriage: Carriage = {
    join: async (topic, token) => {
      const joined = await memory.join(topic, token);
      if (!joined.ok || !topic.includes(':call:')) return joined;
      const send: Line['send'] = async (event, message) => {
        await joined.line.send(event, message);
        return sent;
      };
      return { ok: true, line: { ...joined.line, send } };
    },
  };
  const logs: string[] = [];
  const business = randomUUID();
  const agentId = randomUUID();
  const agent = await startModelAgent({
    carriage,
    keys: parsed.keys,
    key: carryKey(),
    business,
    agent: agentId,
    token: async () => await Promise.resolve('agent-token'),
    custody: {
      dispatch: async () =>
        await Promise.resolve({ kind: 'refused', started: false, code: 'CASE' }),
    },
    log: (kind) => logs.push(kind),
  });
  if ('because' in agent) throw new Error('the agent did not start');
  agents.push(agent);
  const bell = await memory.join(agentTopic(business, agentId), 'database');
  if (!bell.ok) throw new Error('the case could not ring the doorbell');
  lines.push(bell.line);
  const k = randomUUID();
  await bell.line.send('offer', { c: randomUUID(), k });
  await memory.until((said) => said.topic === callTopic(business, k) && said.event === 'accept');
  await turns();
  return logs;
}

it('an accept Realtime did not take is logged as unsent, never as accepted', async () => {
  const logs = await offered('failed');
  expect(logs).toContain('accept unsent');
  expect(logs).not.toContain('accept');
});

it('an accept Realtime took is logged as accepted', async () => {
  const logs = await offered('sent');
  expect(logs).toContain('accept');
  expect(logs).not.toContain('accept unsent');
});

it('each line of the agent log starts with the UTC time it was written', () => {
  const at = new Date(Date.UTC(2026, 9, 15, 6, 15, 37, 324));
  expect(logLine('accept unsent', at)).toBe(
    'model agent: 2026-10-15T06:15:37.324Z accept unsent\n',
  );
});
