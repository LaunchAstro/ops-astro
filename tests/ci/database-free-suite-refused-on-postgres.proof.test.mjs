// SPDX-License-Identifier: AGPL-3.0-only
//
// Rule 7 of scripts/db-conformance.mjs on a server whose configured database
// is `postgres`, where every template builder takes its lock: the migrated
// template's setup must not count as a named suite's database work. It needs
// a database and runs from the repository root:
// DATABASE_URL=... node --test tests/ci/database-free-suite-refused-on-postgres.proof.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import test from 'node:test';

test('setup cannot give a database-free suite a conformance pass when configured for postgres', () => {
  const url = new URL(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL);
  url.pathname = '/postgres';
  const directory = mkdtempSync(resolve('tests/db/tmp-sol-counter-'));
  try {
    const suite = join(directory, 'empty-database-proof.test.ts');
    writeFileSync(
      suite,
      "import { it, expect } from 'vitest';\nit('a suite with no database call', () => { expect(1 + 1).toBe(2); });\n",
    );
    const manifest = join(directory, 'named-suites.json');
    writeFileSync(
      manifest,
      JSON.stringify({ invariant: [relative(process.cwd(), suite)], conformance: [] }),
    );
    const run = spawnSync(
      process.execPath,
      ['scripts/db-conformance.mjs', '--manifest', manifest],
      {
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: url.toString(), DATABASE_ADMIN_URL: url.toString() },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    console.log(run.stdout);
    console.log(run.stderr);
    assert.equal(run.status, 1, 'a suite with no database calls must be refused by rule 7');
    assert.match(run.stderr, /without the database recording a single transaction/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
