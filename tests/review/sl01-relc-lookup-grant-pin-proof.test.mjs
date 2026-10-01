// SPDX-License-Identifier: AGPL-3.0-only
// A PUBLIC column grant must make the lookup grant check fail.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');

test('G2 lookup grant pin rejects an extra PUBLIC businesses column', () => {
  for (const name of ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'FIXTURE_PG_CONTAINER']) {
    assert.ok(process.env[name], `${name} must point at the reviewer's disposable Postgres`);
  }
  const checkout = mkdtempSync(join(tmpdir(), 'sl01-relc-grant-pin-'));
  try {
    const archive = execFileSync('git', ['archive', 'HEAD'], {
      cwd: root,
      maxBuffer: 100 * 1024 * 1024,
    });
    const extracted = spawnSync('tar', ['-xf', '-', '-C', checkout], { input: archive });
    assert.equal(extracted.status, 0, 'could not extract the frozen head');
    symlinkSync(join(root, 'node_modules'), join(checkout, 'node_modules'));

    const check = () =>
      spawnSync(
        join(checkout, 'node_modules/.bin/vitest'),
        ['run', 'tests/db/business-lookup.test.ts'],
        {
          cwd: checkout,
          env: process.env,
          encoding: 'utf8',
        },
      );
    const baseline = check();
    assert.equal(baseline.status, 0, 'the unmutated lookup suite must pass');

    appendFileSync(
      join(checkout, 'migrations/0046_business_lookup.sql'),
      '\ngrant select (created_at) on public.businesses to public;\n',
    );
    const mutant = check();
    assert.notEqual(mutant.status, 0, 'the lookup suite missed an extra PUBLIC column grant');
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});
