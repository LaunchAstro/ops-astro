// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('every pull request runs the existing read catalogue pin without changed imports', () => {
  const run = spawnSync(
    process.execPath,
    [
      'scripts/ci-scope.ts',
      'pin and count tests',
      '--',
      process.execPath,
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
    ],
    {
      env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: '' },
      encoding: 'utf8',
    },
  );
  expect(run.status, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toContain('tests/commands/read-catalogue-pin.test.ts');
});
