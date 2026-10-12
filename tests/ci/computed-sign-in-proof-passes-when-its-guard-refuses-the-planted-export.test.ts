// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { expect, it } from 'vitest';

it('the computed sign-in proof passes and names the export when its guard refuses the planted export', () => {
  const run = spawnSync(
    'node_modules/.bin/vitest',
    ['run', 'tests/ci/computed-sign-in-fixture-export-refused.test.ts'],
    { encoding: 'utf8', timeout: 45_000 },
  );
  const text = stripVTControlCharacters(run.stdout + run.stderr);
  expect(text).toContain('fixture/marker-guard-');
  expect(text).toContain('ISSUER');
  expect(text).toContain('computed-sign-in-fixture-export-refused.test.ts');
  expect(run.status, run.stdout + run.stderr).toBe(0);
}, 60_000);
