// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { PARTS, onOwnCluster, openScratch, revertPart } from './self-test/mutations.ts';

const root = resolve(import.meta.dirname, '../..');

// T3b's unwire takes out the sweeper and nothing a later part wired: the API
// still starts, so S0-6's published-key suite, which runs the real server
// process, passes under it as it does at the head.
test('T3b unwire keeps the API server starting', () => {
  const container = process.env.FIXTURE_PG_CONTAINER;
  assert.ok(container, 'use an isolated Postgres container');
  const published = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' });
  for (const name of ['DATABASE_URL', 'DATABASE_ADMIN_URL']) {
    assert.ok(onOwnCluster(process.env[name] ?? '', published), `${name} must use that container`);
  }

  const scratch = openScratch();
  try {
    symlinkSync(join(root, 'node_modules'), join(scratch.dir, 'node_modules'), 'dir');
    const suite = () =>
      spawnSync(
        join(root, 'node_modules/.bin/vitest'),
        ['run', 'tests/api/published-keys.test.ts'],
        {
          cwd: scratch.dir,
          env: process.env,
          encoding: 'utf8',
          timeout: 120_000,
        },
      );
    assert.equal(suite().status, 0, 'the published-key suite must pass at the unmutated head');

    const part = PARTS.find((candidate) => candidate.id === 'T3b');
    assert.ok(part);
    assert.equal(revertPart(scratch, part, true).applied, true);
    const mutated = suite();
    const output = `${mutated.stdout ?? ''}\n${mutated.stderr ?? ''}`;
    const missing = /does not provide an export named '(\w+)'/u.exec(output)?.[1];
    assert.equal(
      mutated.status,
      0,
      `the API must still start under T3b's unwire; ${missing === undefined ? 'the suite failed' : `server.ts imports ${missing}, which is gone`}`,
    );
  } finally {
    scratch.close();
  }
});
