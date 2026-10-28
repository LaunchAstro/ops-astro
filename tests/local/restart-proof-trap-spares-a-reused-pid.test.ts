// SPDX-License-Identifier: AGPL-3.0-only
//
// Carried proof, kept but for its names: restart-proof.sh's exit trap, run on
// its own, against a pid file whose recorded process has exited and whose
// number now belongs to an unrelated process. The entry is written the way
// the suites' writers write it (`tests/acceptance/restart-process.ts` and
// `kill-harness.ts`: the pid, then a newline), so the trap has nothing but a
// number to go on, and the unrelated process must survive it. Run directly
// rather than inside a node container: nothing here depends on the platform.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { pause } from './restart-proof-sandbox.ts';

const root = resolve(import.meta.dirname, '../..');

test('a recycled pid in the pid file is spared by the exit trap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'restart-proof-reused-pid-'));
  const pidfile = join(dir, 'pids');
  let victim: ChildProcess | undefined;
  try {
    const old = spawn('sleep', ['30'], { stdio: 'ignore' });
    appendFileSync(pidfile, `${String(old.pid)}\n`);
    const ended = new Promise((done) => {
      old.once('exit', done);
    });
    old.kill('SIGKILL');
    await ended;
    victim = spawn('sleep', ['30'], { stdio: 'ignore' });
    expect(victim.pid, 'the old owner ended and the unrelated child started').toBeDefined();
    // Substitute the recycled numeric pid for the departed owner's.
    writeFileSync(pidfile, `${String(victim.pid)}\n`);
    const script = readFileSync(join(root, 'scripts/local/restart-proof.sh'), 'utf8');
    const cleanup = script.slice(
      script.indexOf('cleanup() {'),
      script.indexOf('trap cleanup EXIT'),
    );
    const driver = join(dir, 'cleanup.sh');
    writeFileSync(
      driver,
      `set -euo pipefail\nPIDFILE='${pidfile}'\nEVIDENCE='${join(dir, 'evidence')}'\nAPI_PORT=64000\ncreated=no\nsay() { :; }\nnc() { return 1; }\n${cleanup}\ncleanup\n`,
    );
    const run = spawnSync('bash', [driver], { encoding: 'utf8' });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    await pause(100);
    expect(victim.signalCode, 'the unrelated child must survive the stale evidence entry').toBe(
      null,
    );
  } finally {
    victim?.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
