// SPDX-License-Identifier: AGPL-3.0-only
//
// Vitest reads only .test.ts and .test.tsx, so a node:test file runs only
// when a package script or a workflow names it. Every tests/**/*.test.mjs file
// is named by one, except those filed as #1382: they fail today and wait on their owners.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const WAITING = new Set([
  'tests/api/api-2-quota-cases-catch-cross-business-throttle.test.mjs',
  'tests/api/api-2-quota-held-cases-wait-for-admission.test.mjs',
  'tests/ci/database-free-suite-refused-on-postgres.proof.test.mjs',
  'tests/ci/t2b-crossings-run-with-inbox-under-unwire.test.mjs',
  'tests/ci/t2f-api-health-gate.test.mjs',
  'tests/ci/t2f-unwire-keeps-live-board-running.test.mjs',
  'tests/ci/t2f-unwired-business-joins-run.test.mjs',
  'tests/ci/t3b-unwire-keeps-api-starting.test.mjs',
  'tests/ci/unwire-dependents-exact.test.mjs',
  'tests/review/sl01-relc-lookup-grant-pin-proof.test.mjs',
  'tests/api/api-2-quota-mutation-proof-needs-both-named-cases.test.mjs',
]);

describe('node:test files', () => {
  it('each runs under a package script or a workflow, or waits in #1382', () => {
    const scripts = Object.values(
      (
        JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
          scripts: Record<string, string>;
        }
      ).scripts,
    ).join('\n');
    const workflows = readdirSync(resolve(ROOT, '.github/workflows'))
      .map((file) => readFileSync(resolve(ROOT, '.github/workflows', file), 'utf8'))
      .join('\n');
    const files = execFileSync('git', ['ls-files', 'tests/**/*.test.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    expect(
      files.filter(
        (file) => !scripts.includes(file) && !workflows.includes(file) && !WAITING.has(file),
      ),
    ).toStrictEqual([]);
  });
});
