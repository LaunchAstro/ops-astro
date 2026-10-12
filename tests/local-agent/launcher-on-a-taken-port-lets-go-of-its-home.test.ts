// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1: a launcher whose OPS_LOCAL_AGENT_PORT is already taken refuses by
// name, lets go of the runner's home and files nothing, so the owner's next
// start, on a port that is free, works.

import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startStack, type Stack } from '../../apps/local-agent/stack.ts';
import { makeWorld, type World } from './world.ts';

let world: World | undefined;
let taken: Server | undefined;
let stack: Stack | undefined;
afterEach(async () => {
  await stack?.close();
  const blocker = taken;
  if (blocker !== undefined) {
    await new Promise((resolve) => {
      blocker.close(resolve);
    });
  }
  world?.remove();
  [world, taken, stack] = [undefined, undefined, undefined];
});

it('refuses a taken port, lets go of the home, and starts on a free one after', async () => {
  world = makeWorld();
  const blocker = createServer();
  taken = blocker;
  await new Promise<void>((resolve) => {
    blocker.listen(0, '127.0.0.1', resolve);
  });
  const { port } = blocker.address() as { port: number };
  const refused = await startStack(
    { ...world.env, OPS_LOCAL_AGENT_PORT: String(port) },
    world.userHome,
    () => null,
  );
  expect(refused).toMatchObject({ ok: false, code: 'PORT_IN_USE' });
  expect(existsSync(join(world.agentHome, 'runner.lock'))).toBe(false);
  expect(existsSync(join(world.agentHome, 'credentials.json'))).toBe(false);
  const started = await startStack(world.env, world.userHome, () => null);
  if (!started.ok) throw new Error(started.code);
  stack = started.stack;
  expect(stack.runner.port).not.toBe(port);
});
