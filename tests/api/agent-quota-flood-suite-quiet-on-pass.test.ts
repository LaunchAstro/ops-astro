// SPDX-License-Identifier: AGPL-3.0-only
//
// The flood suite's mutation check runs the door-flood test against a quota
// with no sweep, where that test must fail. When the check passes, CI's log
// carries none of that expected failure: no annotation and no FAIL line naming
// the door-flood test, so a red job is never read as the door-flood test.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('a passing mutation check leaves no failure of the door-flood test in a CI log', () => {
  const result = spawnSync(
    'corepack',
    [
      'pnpm',
      'exec',
      'vitest',
      'run',
      'tests/api/agent-quota-flood-suite-rejects-kept-lapsed-doors.test.ts',
    ],
    {
      cwd: resolve(import.meta.dirname, '../..'),
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ACTIONS: 'true' },
      timeout: 120_000,
    },
  );
  const log = result.stdout + result.stderr;
  expect(result.status, log).toBe(0);
  expect(log, 'an annotation').not.toMatch(/^::error/mu);
  expect(log, 'a FAIL line').not.toMatch(/FAIL\s+tests\/api\/agent-quota-door-flood/u);
}, 120_000);
