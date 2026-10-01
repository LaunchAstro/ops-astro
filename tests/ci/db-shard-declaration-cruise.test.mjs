// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('the database shard declaration is checked by dependency cruise', () => {
  const run = spawnSync(process.execPath, ['scripts/deps-cruise.mjs'], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
});
