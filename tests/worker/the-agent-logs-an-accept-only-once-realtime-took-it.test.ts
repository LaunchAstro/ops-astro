// SPDX-License-Identifier: AGPL-3.0-only
//
// #1667: a first message got MODEL_MACHINE_AWAY while the model agent's log
// said `offer`, then `accept`. The function never heard that accept, and the
// log could not say whether Realtime had taken it, or when. The agent now logs
// `accept` only once its line reports the accept sent, `accept unsent`
// otherwise, and each line of its log carries the UTC time it was written.
// The chat journey runs end to end at the agent: a new chat's first message
// with Gemma picked, accepted, reaches the model as Gemma, and a follow-up
// reaches it with the model and history the hosted side sealed, unchanged. So
// the Qwen follow-ups and the missing question came from what was sent: the
// drawer's `set_model`, and history that carries only answered questions.

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
import {
  PROMPT,
  carryKey,
  chatRequest,
  openAgentWorld,
  type AgentWorld,
} from './model-agent-world.ts';

const lines: Line[] = [];
const agents: ModelAgent[] = [];
let world: AgentWorld | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
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

const GEMMA = 'gemma4:31b-mlx';

/** One message sent on a new call of the world; what the agent logged for it and Ollama was asked. */
async function asked(open: AgentWorld, messages: readonly object[]) {
  const from = open.logs.length;
  const call = await open.call();
  expect(call.accepted).toBe(true);
  const request = chatRequest({ model: GEMMA, messages });
  await call.line.send('request', call.seal('request', call.body(request)));
  await call.until('answer');
  const kinds = new Set(['offer', 'accept', 'started', 'answer']);
  const seen = JSON.parse(open.ollama.seen.at(-1) ?? '{}') as {
    model?: string;
    messages?: unknown;
  };
  return { logged: open.logs.slice(from).filter((kind) => kinds.has(kind)), seen };
}

it('a new chat with Gemma picked reaches the model as Gemma, its follow-up as sent', async () => {
  world = await openAgentWorld();
  const first = [{ role: 'user', content: PROMPT }];
  const opening = await asked(world, first);
  expect(opening.logged).toStrictEqual(['offer', 'accept', 'started', 'answer']);
  expect(opening.seen).toMatchObject({ model: GEMMA, messages: first });
  const followUp = [...first, { role: 'assistant', content: 'Two tasks are due this week.' }];
  const next = await asked(world, [...followUp, { role: 'user', content: 'How about now' }]);
  expect(next.logged).toStrictEqual(['offer', 'accept', 'started', 'answer']);
  expect(next.seen).toMatchObject({
    model: GEMMA,
    messages: [...followUp, { role: 'user', content: 'How about now' }],
  });
  expect(world.handed).toHaveLength(2);
});
