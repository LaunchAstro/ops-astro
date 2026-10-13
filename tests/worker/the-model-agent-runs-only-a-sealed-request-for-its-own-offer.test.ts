// SPDX-License-Identifier: AGPL-3.0-only
//
// The model agent runs only a request the broker sealed, for a call it
// accepted, under its own runner, inside the seal's life. An unsealed
// request, one sealed under another key or the other way, one for another
// call or runner, an expired seal and a body changed after sealing each ask
// Ollama nothing and start nothing. During a rotation either key opens.

import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { carryKey, openAgentWorld, type AgentWorld, type Call } from './model-agent-world.ts';

const WAIT = 15_000;

let world: AgentWorld | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

/** What the agent said on the line after its accept, once 400 ms have passed. */
async function after(call: Call): Promise<readonly string[]> {
  await call.until('started', 1, 400);
  return call.heard.filter((heard) => heard.event !== 'accept').map((heard) => heard.event);
}

const refusals: readonly [string, (call: Call) => unknown][] = [
  ['an unsealed request', (call) => call.body()],
  [
    'a request sealed under another key',
    (call) => call.seal('request', call.body(), { key: carryKey() }),
  ],
  [
    'a request sealed as the agent’s',
    (call) => call.seal('request', call.body(), { direction: 'agent' }),
  ],
  [
    'a request sealed for another call',
    (call) => call.seal('request', call.body(), { k: randomUUID() }),
  ],
  [
    'a request sealed for another runner',
    (call) => call.seal('request', call.body(), { runner: randomUUID() }),
  ],
  [
    'a request whose seal has expired',
    (call) => call.seal('request', call.body(), { expiresAt: Date.now() - 1 }),
  ],
  [
    'a request whose body changed after sealing',
    (call) => ({
      ...(call.seal('request', call.body()) as object),
      body: JSON.stringify({ ...call.body(), deadlineAt: call.acceptedAt + 600_000 }),
    }),
  ],
];

it.each(refusals)(
  '%s asks Ollama nothing and starts nothing',
  async (_name, made) => {
    world = await openAgentWorld();
    const call = await world.call();
    await call.line.send('request', made(call));
    expect(await after(call)).toStrictEqual([]);
    expect(world.ollama.seen.length).toBe(0);
    // Control: the same call's genuine request still runs.
    await call.line.send('request', call.seal('request', call.body()));
    await call.until('answer');
    expect(world.ollama.seen.length).toBe(1);
  },
  WAIT,
);

it(
  'a request sealed with the deadline moved later is refused',
  async () => {
    world = await openAgentWorld();
    const call = await world.call();
    const later = { ...call.body(), deadlineAt: call.acceptedAt + 600_000 };
    await call.line.send('request', call.seal('request', later));
    const [refused] = await call.until('refused');
    expect(world.ollama.seen.length).toBe(0);
    expect(refused?.body).toStrictEqual({ code: 'REQUEST_REFUSED' });
  },
  WAIT,
);

it(
  'during a rotation a request sealed under either key runs',
  async () => {
    const [current, next] = [carryKey(), carryKey()];
    world = await openAgentWorld({ keys: [current, next] });
    const first = await world.call();
    await first.line.send('request', first.seal('request', first.body(), { key: next }));
    await first.until('answer');
    const second = await world.call();
    await second.line.send('request', second.seal('request', second.body(), { key: current }));
    await second.until('answer');
    expect(world.ollama.seen.length).toBe(2);
  },
  WAIT,
);

it(
  'a call line the agent cannot join is not accepted',
  async () => {
    world = await openAgentWorld();
    world.carriage.admit = (topic, token) => token !== 'agent-token' || !topic.includes(':call:');
    const call = await world.call();
    expect(call.accepted).toBe(false);
    await call.line.send('request', call.seal('request', call.body()));
    await call.until('started', 1, 400);
    expect(world.ollama.seen.length).toBe(0);
    // Control: a line it can join is accepted.
    world.carriage.admit = () => true;
    expect((await world.call()).accepted).toBe(true);
  },
  WAIT,
);
