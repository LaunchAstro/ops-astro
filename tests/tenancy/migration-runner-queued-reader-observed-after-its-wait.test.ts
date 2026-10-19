// SPDX-License-Identifier: AGPL-3.0-only
//
// S2007-4: the queued-reader proof observes the waiting session only after it
// is seen waiting on its lock. The review's no-database proof runs that test
// body against controlled doubles, under node's own test runner, which this
// case runs as its own process.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('observes the queued reader only once it waits on its lock', async () => {
  const run = await promisify(execFile)(
    process.execPath,
    ['--test', 'tests/tenancy/migration-runner-queued-reader-observed-after-its-wait.proof.mjs'],
    { env: { PATH: process.env['PATH'] ?? '' } },
  ).then(
    ({ stdout }) => ({ code: 0, stdout }),
    (error: { readonly code?: number; readonly stdout?: string }) => ({
      code: error.code,
      stdout: error.stdout ?? '',
    }),
  );

  expect(run.stdout).toContain('"waiting":true');
  expect(run.code).toBe(0);
}, 60_000);
