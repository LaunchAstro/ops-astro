// SPDX-License-Identifier: AGPL-3.0-only
//
// Above a one-minute load of 45 the machine is too busy to start a model:
// the agent refuses sealed with `MODEL_MACHINE_BUSY` before custody, and
// Ollama is asked nothing. At 45 it runs.

import { afterEach, expect, it } from 'vitest';
import { openAgentWorld, type AgentWorld } from './model-agent-world.ts';

const WAIT = 15_000;

let world: AgentWorld | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

it(
  'a load above 45 refuses before custody',
  async () => {
    world = await openAgentWorld({ load: () => 45.5 });
    const call = await world.call();
    await call.line.send('request', call.seal('request', call.body()));
    const [refused] = await call.until('refused');
    expect(world.handed).toStrictEqual([]);
    expect(world.ollama.seen.length).toBe(0);
    expect(refused?.body).toStrictEqual({ code: 'MODEL_MACHINE_BUSY' });
  },
  WAIT,
);

it(
  'control: a load of 45 runs',
  async () => {
    world = await openAgentWorld({ load: () => 45 });
    const call = await world.call();
    await call.line.send('request', call.seal('request', call.body()));
    await call.until('answer');
    expect(world.ollama.seen.length).toBe(1);
  },
  WAIT,
);
