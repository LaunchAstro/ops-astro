// SPDX-License-Identifier: AGPL-3.0-only
//
// Races the model agent and its gated send already hold, kept as proof:
// two agents on one login run a call once, under the runner the function
// took; a repeated offer while the first join is under way joins once; an
// offer or a sealed request naming its call in another case or scope starts
// nothing; a `settled` for another runner stops nothing; custody lost
// mid-answer and the request heard again asks the model no second time; a
// restarted agent never runs its predecessor's request.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentTopic,
  parseCarryKeys,
  type Carriage,
  type Line,
} from '../../packages/core-custody/src/agent.ts';
import { startModelAgent, type ModelAgent } from '../../apps/model-agent/carrier.ts';
import { memoryCarriage } from '../support/memory-carriage.ts';
import { openRaceWorld, type RaceWorld } from './carried-race-world.ts';
import { carryKey, openAgentWorld, type AgentWorld } from './model-agent-world.ts';

const WAIT = 20_000;

let world: AgentWorld | undefined;
let race: RaceWorld | undefined;
const extra: { stop(): Promise<void> }[] = [];
const lines: Line[] = [];

afterEach(async () => {
  for (const each of extra.splice(0)) await each.stop(); // oxlint-disable-line no-await-in-loop
  for (const line of lines.splice(0)) await line.leave(); // oxlint-disable-line no-await-in-loop
  await world?.close();
  await race?.close();
  world = undefined;
  race = undefined;
});

const nothing = (): void => {};

/** A promise opened by hand. */
function latch(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open = nothing;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function turns(n = 5): Promise<void> {
  for (let at = 0; at < n; at += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one turn after another
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** The world's doorbell, joined as the database rings it. */
async function bellOf(opened: AgentWorld): Promise<Line> {
  const bell = await opened.carriage.join(agentTopic(opened.business, opened.agentId), 'database');
  if (!bell.ok) throw new Error('the doorbell could not be joined');
  lines.push(bell.line);
  return bell.line;
}

/** A second agent process on the world's login and carriage, with custody as the world's. */
async function anotherAgent(opened: AgentWorld): Promise<ModelAgent> {
  const parsed = parseCarryKeys(opened.key);
  if (!parsed.ok) throw new Error('the case made a malformed carry key');
  const agent = await startModelAgent({
    carriage: opened.carriage,
    keys: parsed.keys,
    key: opened.key,
    business: opened.business,
    agent: opened.agentId,
    token: async () => await Promise.resolve('agent-token'),
    custody: {
      dispatch: async (request, gate, onPiece) => {
        opened.handed.push(request);
        return await opened.custody.dispatchBefore('ollama_key', request, gate, onPiece);
      },
    },
  });
  if ('because' in agent) throw new Error('the second agent did not start');
  extra.push(agent);
  return agent;
}

describe('two agent processes on one login', () => {
  it(
    'both accept; only the runner the function took runs, and the model is asked once',
    async () => {
      race = await openRaceWorld();
      await race.startAgent();
      await race.startAgent();
      const outcome = await race.carry();
      const accepts = race.carriage.said.filter((said) => said.event === 'accept');
      const starts = race.carriage.said.filter((said) => said.event === 'started');
      expect(accepts).toHaveLength(2);
      expect(starts).toHaveLength(1);
      expect(outcome.kind).toBe('answered');
      expect(race.handed).toHaveLength(1);
      expect(race.ollama.seen).toHaveLength(1);
    },
    WAIT,
  );
});

// oxlint-disable-next-line max-lines-per-function -- the held join and the offers spelled otherwise
describe('offers', () => {
  it('a repeated offer while the first join is under way joins and accepts once', async () => {
    const key = carryKey();
    const parsed = parseCarryKeys(key);
    if (!parsed.ok) throw new Error('the case made a malformed carry key');
    const memory = memoryCarriage();
    let joins = 0;
    const { promise: held, open: go } = latch();
    const carriage: Carriage = {
      join: async (topic, token) => {
        if (token === 'agent-token' && topic.includes(':call:')) {
          joins += 1;
          await held;
        }
        return await memory.join(topic, token);
      },
    };
    const business = randomUUID();
    const agentId = randomUUID();
    const agent = await startModelAgent({
      carriage,
      keys: parsed.keys,
      key,
      business,
      agent: agentId,
      token: async () => await Promise.resolve('agent-token'),
      custody: { dispatch: async () => await Promise.reject(new Error('not asked')) },
    });
    if ('because' in agent) throw new Error('the agent did not start');
    extra.push(agent);
    const bell = await memory.join(agentTopic(business, agentId), 'database');
    if (!bell.ok) throw new Error('the doorbell could not be joined');
    lines.push(bell.line);
    const k = randomUUID();
    await bell.line.send('offer', { c: randomUUID(), k });
    await turns();
    await bell.line.send('offer', { c: randomUUID(), k });
    await turns();
    go();
    await turns();
    expect(joins).toBe(1);
    expect(memory.said.filter((said) => said.event === 'accept')).toHaveLength(1);
  });

  it.each([
    ['upper case', (k: string) => k.toUpperCase()],
    ['another business named in it', (k: string) => `${randomUUID()}:call:${k}`],
  ])('an offer whose call id has %s is not joined', async (_name, spell) => {
    world = await openAgentWorld();
    const bell = await bellOf(world);
    const k = randomUUID();
    await bell.send('offer', { c: randomUUID(), k: spell(k) });
    await turns();
    expect(world.carriage.joined().filter((topic) => topic.includes(':call:'))).toStrictEqual([]);
    expect(world.carriage.said.filter((said) => said.event === 'accept')).toStrictEqual([]);
  });
});

describe('sealed messages naming another call or runner', () => {
  it(
    'a request sealed for the call in upper case starts nothing',
    async () => {
      world = await openAgentWorld();
      const call = await world.call();
      await call.line.send(
        'request',
        call.seal('request', call.body(), { k: call.k.toUpperCase() }),
      );
      await call.until('started', 1, 400);
      expect(call.heard.map((heard) => heard.event)).toStrictEqual(['accept']);
      expect(world.ollama.seen).toHaveLength(0);
      // Control: the genuine request runs.
      await call.line.send('request', call.seal('request', call.body()));
      await call.until('answer');
      expect(world.ollama.seen).toHaveLength(1);
    },
    WAIT,
  );

  // oxlint-disable-next-line max-lines-per-function -- the answer, both settles and the replay in one case
  it(
    'a settled for another runner stops nothing; the genuine one stops the resends',
    async () => {
      world = await openAgentWorld();
      const call = await world.call();
      await call.line.send('request', call.seal('request', call.body()));
      await call.until('answer');
      await call.line.send('settled', call.seal('settled', {}, { runner: randomUUID() }));
      await call.until('answer', 2, 3_000);
      expect(world.logs).not.toContain('settled');
      await call.line.send('settled', call.seal('settled', {}));
      await call.until('never', 1, 200);
      const answers = call.heard.filter((heard) => heard.event === 'answer').length;
      // A replay of the request after settling is not heard: the line is left.
      await call.line.send('request', call.seal('request', call.body()));
      await call.until('answer', answers + 1, 2_500);
      expect(world.logs.filter((kind) => kind === 'settled')).toHaveLength(1);
      expect(call.heard.filter((heard) => heard.event === 'answer')).toHaveLength(answers);
      expect(world.ollama.seen).toHaveLength(1);
    },
    WAIT,
  );
});

// oxlint-disable-next-line max-lines-per-function -- a lost custody and a restart, each in full
describe('crash and retry', () => {
  it(
    'custody lost mid-answer, then the request heard again, asks the model no second time',
    async () => {
      world = await openAgentWorld();
      const opened = world;
      opened.ollama.reply = (model) => ({
        status: 200,
        chunks: [`${JSON.stringify({ model, message: { content: 'Two ' }, done: false })}\n`, ''],
        holdAfter: 1,
      });
      const call = await opened.call();
      const request = call.seal('request', call.body());
      await call.line.send('request', request);
      await opened.ollama.midway();
      opened.custody.kill();
      for (let tries = 0; tries < 200 && !opened.logs.includes('custody lost'); tries += 1) {
        await sleep(10); // oxlint-disable-line no-await-in-loop
      }
      await call.line.send('request', request);
      await call.until('answer', 1, 500);
      expect(opened.logs).toContain('custody lost');
      expect(opened.handed).toHaveLength(1);
      expect(opened.ollama.seen).toHaveLength(1);
      expect(call.heard.filter((heard) => heard.event === 'answer')).toStrictEqual([]);
    },
    WAIT,
  );

  it(
    'a restarted agent accepts a repeated offer as a new runner and never runs the old request',
    async () => {
      world = await openAgentWorld();
      const call = await world.call();
      const request = call.seal('request', call.body());
      await call.line.send('request', request);
      await call.until('answer');
      await world.agent.stop();
      const restarted = await anotherAgent(world);
      const bell = await bellOf(world);
      await bell.send('offer', { c: randomUUID(), k: call.k });
      const accepts = await call.until('accept', 2, 1_500);
      expect(accepts.at(-1)?.runner).toBe(restarted.runner);
      await call.line.send('request', request);
      await call.until('started', 2, 400);
      expect(call.heard.filter((heard) => heard.event === 'started')).toHaveLength(1);
      expect(world.ollama.seen).toHaveLength(1);
    },
    WAIT,
  );
});
