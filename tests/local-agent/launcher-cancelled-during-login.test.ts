// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 cut 3: a launcher stopped with Ctrl-C while its login check is still
// out takes that check with it. The check runs in a process group of its own
// (so its deadline can stop a wrapper's descendants), outside the terminal's
// Ctrl-C, so the launcher stops the group itself before it goes.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { makeWorld, type World } from './world.ts';

let world: World | undefined;
const left: number[] = [];
afterEach(() => {
  for (const pid of left.splice(0)) if (alive(pid)) process.kill(pid, 'SIGKILL');
  world?.remove();
  world = undefined;
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const pidIn = (file: string): number | null =>
  existsSync(file) ? Number(readFileSync(file, 'utf8')) : null;

it('Ctrl-C while the login check is out stops the check and its descendant too', async () => {
  world = makeWorld();
  world.knobs({ login: 'wrapper' });
  const launcher = spawn(process.execPath, ['apps/local-agent/stack.ts'], {
    env: world.env,
    stdio: 'ignore',
  });
  const wrapperFile = join(world.codexHome, 'wrapper.pid');
  const descendantFile = join(world.codexHome, 'descendant.pid');
  await expect
    .poll(() => pidIn(wrapperFile) !== null && pidIn(descendantFile) !== null, { timeout: 4_000 })
    .toBe(true);
  const pids = [pidIn(wrapperFile) ?? 0, pidIn(descendantFile) ?? 0];
  left.push(...pids);
  const exited = once(launcher, 'exit');
  launcher.kill('SIGINT');
  await exited;
  // Well inside the ten-second deadline the launcher no longer runs to keep.
  await expect.poll(() => pids.filter((pid) => alive(pid)), { timeout: 3_000 }).toStrictEqual([]);
}, 15_000);
