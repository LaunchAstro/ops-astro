// SPDX-License-Identifier: AGPL-3.0-only
//
// A request that reaches the agent after its call's deadline is refused
// with a sealed `SEND_LAPSED`, however long after: custody wrote nothing, so
// the function releases the call. Ignored in silence, the function would
// hear neither `written` nor a refusal, take the silence for an unknown,
// and hold a call that provably asked the model nothing.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { SEND_WINDOW_MS } from '../../packages/core-custody/src/agent.ts';
import { openAgentWorld, type AgentWorld } from './model-agent-world.ts';
import { openRaceWorld, type RaceWorld } from './carried-race-world.ts';

let world: AgentWorld | undefined;
let race: RaceWorld | undefined;

afterEach(async () => {
  await world?.close();
  await race?.close();
  world = undefined;
  race = undefined;
});

it('a request that comes once the deadline has passed in real time gets a sealed refusal', async () => {
  world = await openAgentWorld();
  const call = await world.call();
  // The deadline is the accept plus W on the agent's own clock; this lets it pass.
  await sleep(Math.max(0, call.acceptedAt + SEND_WINDOW_MS + 50 - Date.now()));
  await call.line.send('request', call.seal('request', call.body()));
  const [refused] = await call.until('refused', 1, 1_500);
  expect(world.ollama.seen).toHaveLength(0);
  expect(world.handed).toStrictEqual([]);
  expect(refused?.body).toStrictEqual({ code: 'SEND_LAPSED' });
}, 15_000);

it('a send judgement that outlasts W ends the call refused, not held', async () => {
  race = await openRaceWorld();
  await race.startAgent();
  // The judgement waits on its locks past the deadline; the request then goes late.
  const outcome = await race.carry(async (accept) => {
    await sleep(Math.max(0, accept.acceptedAt + SEND_WINDOW_MS + 100 - Date.now()));
  });
  expect(race.ollama.seen).toHaveLength(0);
  expect(race.handed).toStrictEqual([]);
  // Released as unsent: nothing was written, whichever end says so.
  expect(outcome).toMatchObject({ kind: 'refused', started: false });
}, 15_000);
