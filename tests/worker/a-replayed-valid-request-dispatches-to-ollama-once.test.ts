// SPDX-License-Identifier: AGPL-3.0-only
//
// The model agent runs each call once. A valid sealed request heard twice,
// twenty times at once, or again after its answer asks Ollama once; a replay
// after the answer gets the same sealed answer back; a request sealed for
// another runner (an earlier process) asks nothing.

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openAgentWorld, type AgentWorld } from './model-agent-world.ts';

/** Each case waits on real custody and a real stand-in; a wait that never ends is the failure. */
const WAIT = 15_000;

let world: AgentWorld;

beforeEach(async () => {
  world = await openAgentWorld();
});

afterEach(async () => {
  await world.close();
});

it(
  'the same sealed request heard twice at once asks Ollama once',
  async () => {
    const call = await world.call();
    const request = call.seal('request', call.body());
    await Promise.all([call.line.send('request', request), call.line.send('request', request)]);
    await call.until('answer');
    expect(world.ollama.seen.length).toBe(1);
    expect(call.heard.filter((heard) => heard.event === 'started')).toHaveLength(1);
  },
  WAIT,
);

it(
  'the same sealed request heard twenty times at once asks Ollama once',
  async () => {
    const call = await world.call();
    const request = call.seal('request', call.body());
    await Promise.all(Array.from({ length: 20 }, () => call.line.send('request', request)));
    await call.until('answer');
    expect(world.ollama.seen.length).toBe(1);
    expect(world.handed).toHaveLength(1);
  },
  WAIT,
);

it(
  'a replay after the answer asks nothing and gets the same sealed answer back',
  async () => {
    const call = await world.call();
    const request = call.seal('request', call.body());
    await call.line.send('request', request);
    const [first] = await call.until('answer');
    await call.line.send('request', request);
    const answers = await call.until('answer', 2);
    expect(world.ollama.seen.length).toBe(1);
    expect(answers).toHaveLength(2);
    expect(answers[1]?.raw).toStrictEqual(first?.raw);
  },
  WAIT,
);

it(
  'a request sealed for another runner asks nothing',
  async () => {
    const call = await world.call();
    expect(call.accepted).toBe(true);
    await call.line.send('request', call.seal('request', call.body(), { runner: randomUUID() }));
    await call.until('started', 1, 500);
    expect(world.ollama.seen.length).toBe(0);
    expect(call.heard.filter((heard) => heard.event !== 'accept')).toStrictEqual([]);
    // Control: the accept's own runner runs it.
    await call.line.send('request', call.seal('request', call.body()));
    await call.until('answer');
    expect(world.ollama.seen.length).toBe(1);
  },
  WAIT,
);
