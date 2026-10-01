// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('fails a required CI invocation that skips the inbox worker restart proof', () => {
  const { L5_RUNTIME_PROOFS: _asked, L5_RESTART_API_PORT: _port, ...environment } = process.env;
  const result = spawnSync(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', 'tests/acceptance/inbox-worker-restart.test.ts'],
    { env: { ...environment, CI: 'true' }, encoding: 'utf8' },
  );
  const output = result.stdout + result.stderr;
  expect(output).toContain('skipped');
  expect(result.status, 'a skipped required restart proof must make the check red').not.toBe(0);
}, 60_000);
