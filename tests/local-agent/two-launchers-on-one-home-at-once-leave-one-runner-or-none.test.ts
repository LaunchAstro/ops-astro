// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1: two launchers started at once on one runner home, one on a port
// something else already listens on. The home is taken before the port, and a
// taken port lets it go again. Whichever order the two meet the lock in, at
// most one runner holds the home; the one that runs is the one the filed key
// and the lock name; and when neither runs, the home is left free.

import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startStack, type StackStart } from '../../apps/local-agent/stack.ts';
import { makeWorld, RUNNER_KEY, type World } from './world.ts';

let world: World | undefined;
let taken: Server | undefined;
const started: StackStart[] = [];
afterEach(async () => {
  for (const each of started.splice(0)) if (each.ok) await each.stack.close();
  const blocker = taken;
  if (blocker !== undefined) {
    await new Promise((resolve) => {
      blocker.close(resolve);
    });
  }
  world?.remove();
  [world, taken] = [undefined, undefined];
});

async function takenPort(): Promise<number> {
  const blocker = createServer();
  taken = blocker;
  await new Promise<void>((resolve) => {
    blocker.listen(0, '127.0.0.1', resolve);
  });
  return (blocker.address() as { port: number }).port;
}

it('two launchers at once on one home, one on a taken port, leave one runner or none', async () => {
  world = makeWorld();
  const port = await takenPort();
  const lock = join(world.agentHome, 'runner.lock');
  for (let round = 0; round < 3; round += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one round at a time, each two at once
    const both = await Promise.all([
      startStack({ ...world.env, OPS_LOCAL_AGENT_PORT: String(port) }, world.userHome, () => null),
      startStack(world.env, world.userHome, () => null),
    ]);
    started.push(...both);
    const [onTaken, onFree] = both;
    expect(onTaken).toMatchObject({ ok: false });
    expect(['PORT_IN_USE', 'LOCAL_HOME_IN_USE']).toContain(
      onTaken?.ok === false ? onTaken.code : '',
    );
    if (onFree?.ok === true) {
      expect(readFileSync(lock, 'utf8').startsWith(`${String(process.pid)} `)).toBe(true);
      expect(readFileSync(onFree.stack.credentialsFile, 'utf8')).toContain(RUNNER_KEY);
      // oxlint-disable-next-line no-await-in-loop -- the next round starts on a free home
      await onFree.stack.close();
    } else {
      expect(onFree).toMatchObject({ ok: false, code: 'LOCAL_HOME_IN_USE' });
    }
    expect(existsSync(lock)).toBe(false);
  }
}, 30_000);
