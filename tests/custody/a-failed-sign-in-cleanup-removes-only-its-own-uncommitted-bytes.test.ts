// SPDX-License-Identifier: AGPL-3.0-only
import * as fs from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { storeSignIn } from '../../packages/core-custody/src/plan-sign-in.ts';
import { HOUR, T0, faultyFs, seed, tempDir } from './fixtures/plan-token-world.ts';
import { HOST_ID, ISSUED, seedHost, signInTokens } from './fixtures/sign-in-world.ts';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function waitSync(path: string): void {
  const until = Date.now() + 8000;
  while (!fs.existsSync(path)) {
    if (Date.now() >= until) throw new Error(`child did not reach ${path}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

it('an unwritten store of the pair already committed leaves that committed pair in place', async () => {
  const { file, done } = tempDir();
  cleanup = done;
  await seedHost(file, { extAgentHostId: HOST_ID, clientId: ISSUED });
  const pair = signInTokens('same', T0 + HOUR);
  await seed(file, { state: 'ready', tokens: pair });
  const before = fs.readFileSync(file);
  expect(
    await storeSignIn(
      { file, fs: faultyFs({ step: 'file-fsync', on: 'ready' }) },
      { hostId: HOST_ID, clientId: ISSUED },
      pair,
    ),
  ).toEqual({ ok: false, code: 'SIGN_IN_STORE_FAILED' });
  expect(fs.existsSync(file), 'the failed write never replaced the existing committed file').toBe(
    true,
  );
  expect(fs.readFileSync(file)).toEqual(before);
});

// oxlint-disable-next-line max-lines-per-function -- one race, both processes' steps in order
it('a sign-in cleanup past its own hold leaves a refresh another holder committed', async () => {
  const { spawn } = await import('node:child_process');
  const { join } = await import('node:path');
  const { file, dir, done } = tempDir();
  cleanup = done;
  await seedHost(file, { extAgentHostId: HOST_ID, clientId: ISSUED });
  await seed(file, { state: 'ready', tokens: signInTokens('old', T0 + 180_000) });
  const ready = join(dir, 'refresh-ready');
  const release = join(dir, 'refresh-release');
  const finished = join(dir, 'refresh-finished');
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  let displaced = false;
  // Set when A's cleanup removes the token file; a cleanup that never removes
  // it is checked once both sides finish.
  let winnerVisibleBeforeRemove: boolean | undefined;
  try {
    const result = await storeSignIn(
      {
        file,
        fs: {
          openSync: (path, flags, mode) => {
            if (displaced || !String(path).endsWith('.next')) return fs.openSync(path, flags, mode);
            displaced = true;
            // A loses its lock before opening its temp file. B reads the old committed pair,
            // commits pending and sends its real refresh under the replacement lock.
            fs.unlinkSync(`${file}.lock`);
            child = spawn(
              process.execPath,
              [
                join(
                  import.meta.dirname,
                  'fixtures/a-refresh-holder-during-a-sign-in-cleanup-child.ts',
                ),
                JSON.stringify({ file, ready, release, done: finished, at: T0 }),
              ],
              {
                stdio: 'ignore',
                env: { ...process.env, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
              },
            );
            exited = new Promise((resolve) => {
              child!.once('exit', resolve);
            });
            waitSync(ready);
            return fs.openSync(path, flags, mode);
          },
          rmSync: (path, options) => {
            if (String(path) === file) {
              // withdraw has already compared A's uncommitted bytes. Let B's
              // refresh finish and commit before A performs its queued unlink.
              fs.writeFileSync(release, 'finish refresh');
              waitSync(finished);
              winnerVisibleBeforeRemove = fs
                .readFileSync(file, 'utf8')
                .includes('synthetic-refresh-winner');
            }
            fs.rmSync(path, options);
          },
        },
      },
      { hostId: HOST_ID, clientId: ISSUED },
      signInTokens('failed', T0 + HOUR),
    );
    if (!fs.existsSync(release)) fs.writeFileSync(release, 'finish refresh');
    await exited;
    winnerVisibleBeforeRemove ??=
      fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('synthetic-refresh-winner');
    expect(result).toEqual({ ok: false, code: 'SIGN_IN_STORE_FAILED' });
    expect(JSON.parse(fs.readFileSync(finished, 'utf8'))).toMatchObject({
      result: { ok: true },
      present: { ok: true, accessToken: 'synthetic-access-winner' },
    });
    expect(winnerVisibleBeforeRemove).toBe(true);
    expect(fs.existsSync(file), 'A must not unlink B’s successful committed refresh').toBe(true);
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
}, 20_000);
