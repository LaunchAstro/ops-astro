// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function, no-promise-executor-return -- Sol's proof, kept as written */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { expect, it } from 'vitest';
import { readStamp } from '../../apps/web/build-stamp.ts';

it('a concurrent bundle copy retains an asset listed before the preservation suite finishes', async () => {
  const root = resolvePath(import.meta.dirname, '../..');
  const dist = join(root, 'apps/web/dist');
  const asset = join(dist, 'assets/sol-check-owned.js');
  const stamp = readStamp(dist);
  expect(stamp, 'build the checked bundle before this proof').toBeDefined();
  expect(existsSync(asset)).toBe(false);
  const scratch = mkdtempSync(join(tmpdir(), 'sol-reader-'));
  const child = spawn(
    'corepack',
    [
      'pnpm',
      'exec',
      'vitest',
      'run',
      'tests/ci/production-font-suite-keeps-the-checked-bundle.test.ts',
    ],
    {
      cwd: root,
      env: { ...process.env, CHECK_WEB_BUILD: stamp },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  const finished = new Promise<number | null>((resolve) => child.on('close', resolve));
  try {
    const deadline = Date.now() + 120_000;
    while (!existsSync(asset) && Date.now() < deadline && child.exitCode === null) {
      // oxlint-disable-next-line no-await-in-loop -- wait for another process to publish the asset
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!existsSync(asset)) {
      expect(await finished, output).toBe(0);
      return;
    }
    let reachedAsset = false;
    let copyError: unknown;
    try {
      cpSync(dist, join(scratch, 'dist'), {
        recursive: true,
        filter: (source) => {
          if (source === asset) {
            reachedAsset = true;
            // Pause the real copier after directory enumeration and before
            // its lstat/copy. The other process runs the real suite and cleanup.
            const wait = spawnSync(
              process.execPath,
              [
                '-e',
                'const fs=require("node:fs"); const end=Date.now()+120000; while(fs.existsSync(process.argv[1]) && Date.now()<end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); process.exit(fs.existsSync(process.argv[1])?1:0);',
                asset,
              ],
              { timeout: 130_000 },
            );
            expect(wait.status).toBe(0);
          }
          return true;
        },
      });
    } catch (error) {
      copyError = error;
    }
    expect(await finished, output).toBe(0);
    expect(reachedAsset).toBe(true);
    expect(
      copyError,
      'the shared bundle must remain copyable across the suite cleanup',
    ).toBeUndefined();
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await finished;
    rmSync(scratch, { recursive: true, force: true });
  }
}, 300_000);
