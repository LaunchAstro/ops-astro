// SPDX-License-Identifier: AGPL-3.0-only
//
// `pnpm check:records` (scripts/check-records.ts) runs the record-keeping checks with no database
// before a pull request is queued. Its last line names each failed test, which the orchestrator
// reports, so this proves the names it reads from vitest's report, and that the files it runs
// are there and include the ones merge groups failed on.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { failedTests, RECORD_TESTS } from '../../scripts/check-records.ts';

const ROOT = join(import.meta.dirname, '../..');

const SLOW = 'Error: Test timed out in 12000ms.\nIf this is a long-running test, pass a timeout';

it('names each failed test by file and full name, and a file that failed with none', () => {
  const shards = 'tests/ci/ci-shards.test.ts';
  const report = {
    testResults: [
      {
        name: join(ROOT, shards),
        assertionResults: [
          { status: 'passed', title: 'a', fullName: 'plan > a' },
          { status: 'failed', title: 'b', fullName: 'plan > b', failureMessages: ['Assertion'] },
          { status: 'failed', title: 'c', failureMessages: [SLOW] },
          { status: 'failed', title: 'd', failureMessages: [SLOW, 'AssertionError: x'] },
        ],
      },
      { name: join(ROOT, 'tests/ci/db-shards.test.ts'), message: 'import failed' },
      { name: join(ROOT, 'tests/ci/ci-scope.test.ts'), assertionResults: [] },
    ],
  };
  expect(failedTests(report, ROOT)).toStrictEqual([
    { name: `${shards} > plan > b`, file: shards, timedOut: false },
    { name: `${shards} > c`, file: shards, timedOut: true },
    { name: `${shards} > d`, file: shards, timedOut: false },
    { name: 'tests/ci/db-shards.test.ts', file: 'tests/ci/db-shards.test.ts', timedOut: false },
  ]);
  expect(failedTests({}, ROOT)).toStrictEqual([]);
});

it('lists only files that are there, among them the ones merge groups failed on', () => {
  const listed = spawnSync(process.execPath, ['scripts/check-records.ts', '--list'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  expect(listed.status, listed.stderr).toBe(0);
  const files = listed.stdout.trim().split('\n');
  expect(files).toStrictEqual(Object.values(RECORD_TESTS).flat());
  expect(files).toEqual(
    expect.arrayContaining([
      'tests/db/named-suite-manifest.test.ts',
      'tests/docs/test-files-by-behaviour.test.ts',
      'tests/ci/ci-shards.test.ts',
      'tests/ci/merge-group-workflows.test.ts',
    ]),
  );
});

it('refuses a base that is not a full commit id, and runs as pnpm check:records', () => {
  const bad = spawnSync(process.execPath, ['scripts/check-records.ts', '--base', 'main'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  expect(bad.status).toBe(2);
  expect(bad.stderr).toContain('is not a full commit id');
  const scripts = (
    JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  expect(scripts['check:records']).toBe('node scripts/check-records.ts');
});
