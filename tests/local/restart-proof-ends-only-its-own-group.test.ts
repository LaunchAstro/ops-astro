// SPDX-License-Identifier: AGPL-3.0-only
//
// restart-proof.sh ends what its suites started by their process group, from
// inside that group, and never by a pid read from a file: a recorded pid can
// belong to someone else by the time the trap runs. The group ends however
// the run ends, its own SIGKILL included, and at any point after the fork.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  alive,
  endLeftovers,
  pause,
  type Sandbox,
  sandbox,
  until,
} from './restart-proof-sandbox.ts';

let box: Sandbox | undefined;
afterEach(() => {
  if (box !== undefined) {
    endLeftovers(box);
    box.remove();
  }
  box = undefined;
});

it('a recorded pid outside the run group survives the trap', async () => {
  box = sandbox();
  const bystander = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const ran = await box.run([], {
      // The way the suites' writers record a pid: the number, then a newline.
      STANDIN_SUITE: `printf '%s\\n' ${String(bystander.pid)} >>"$L5_RESTART_PIDFILE"`,
    });
    expect(ran.status, ran.out).toBe(0);
    await pause(100);
    expect(bystander.signalCode, 'a process the run did not start is never signalled').toBe(null);
    expect(bystander.exitCode).toBe(null);
  } finally {
    bystander.kill('SIGKILL');
  }
}, 20_000);

it('an API started by a suite is in the group and gone after the trap', async () => {
  box = sandbox();
  const ran = await box.run();
  expect(ran.status, ran.out).toBe(0);
  const [suite] = box.recorded('suite');
  const [api] = box.recorded('api');
  expect(api && alive(api.pid), 'the API the suite left running').toBe(false);
  expect(api?.pgid).toBe(suite?.pgid);
  expect(readFileSync(box.evidence, 'utf8')).toContain(
    `process group ended: ${String(suite?.pgid)}\n`,
  );
}, 20_000);

it('SIGKILL of restart-proof.sh still ends every suite process', async () => {
  box = sandbox();
  const run = box.start([], { STANDIN_SUITE: 'sleep 30' });
  const current = box;
  expect(await until(() => current.recorded('api').length > 0, 10_000)).toBe(true);
  run.kill('SIGKILL');
  const left = () =>
    [...current.recorded('suite'), ...current.recorded('api')].filter(({ pid }) => alive(pid));
  await until(() => left().length === 0, 5_000);
  expect(left(), 'suite processes still running after restart-proof.sh died').toStrictEqual([]);
}, 20_000);

it('killing restart-proof between fork and keeper arming still ends the group', async () => {
  box = sandbox();
  const current = box;
  const arming = join(current.dir, 'arming');
  const run = box.start([], { STANDIN_SUITE: 'sleep 30', L5_RESTART_ARMING_PAUSE: arming });
  const paused = () => readFileSync(arming, { encoding: 'utf8', flag: 'a+' }).trim();
  // Paused before the keeper holds the read end, or (without the pause) the suite already up.
  const reached = () => paused() !== '' || current.recorded('api').length > 0;
  expect(await until(reached, 10_000)).toBe(true);
  run.kill('SIGKILL');
  // The pause is a second long; give the job its second, then everything it ran must be gone.
  await pause(1500);
  const pids = () => [
    ...(paused() === '' ? [] : [Number(paused())]),
    ...current.recorded('suite').map(({ pid }) => pid),
    ...current.recorded('api').map(({ pid }) => pid),
  ];
  await until(() => pids().every((pid) => !alive(pid)), 5_000);
  expect(
    pids().filter((pid) => alive(pid)),
    'members of the run group still running',
  ).toStrictEqual([]);
}, 20_000);
