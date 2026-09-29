// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('Sol proof, criterion 2: the existing API health test accepts the T2f response', () => {
  const result = spawnSync(
    'corepack',
    [
      'pnpm',
      'exec',
      'vitest',
      'run',
      'tests/api/server-onerror.test.ts',
      '-t',
      'measures /api/health on the administrative connection',
    ],
    { encoding: 'utf8', timeout: 120_000 },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
