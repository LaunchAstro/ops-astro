// SPDX-License-Identifier: AGPL-3.0-only
// Sol's review proofs for PR #1570. Faults are planted only in disposable clones.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { failedTests, RECORD_TESTS } from '../../scripts/check-records.ts';

const ROOT = join(import.meta.dirname, '../..');
const BASE = '516dd3944424042beeafc51c702273f2b9a90df7';
const HEALTHY =
  "import { it, expect } from 'vitest';\nit('healthy record', () => expect(1).toBe(1));\n";

function inClone(check: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'records-run-proof-'));
  try {
    const clone = spawnSync('git', ['clone', '--quiet', '--shared', ROOT, root], {
      encoding: 'utf8',
    });
    expect(clone.status, clone.stderr).toBe(0);
    symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
    for (const file of Object.values(RECORD_TESTS).flat()) {
      writeFileSync(join(root, file), HEALTHY);
    }
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function run(root: string, args: string[]) {
  const env = { ...process.env };
  delete env['DATABASE_URL'];
  delete env['DATABASE_ADMIN_URL'];
  return spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

it('an assertion quoting a timeout is a real failure', () => {
  inClone((root) => {
    const file = 'tests/ci/ci-jobs-time-out.test.ts';
    writeFileSync(
      join(root, file),
      [
        "import { it, expect } from 'vitest';",
        "it('rejects the wrong timeout diagnostic', () => {",
        "  expect('Test timed out in 50ms').toBe('no timeout');",
        '});',
      ].join('\n'),
    );
    const reportPath = join(root, 'actual-report.json');
    const child = run(root, [
      'node_modules/vitest/vitest.mjs',
      'run',
      file,
      '--reporter=json',
      `--outputFile=${reportPath}`,
    ]);
    expect(child.status, child.stderr).toBe(1);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(report.testResults[0].assertionResults[0].failureMessages[0]).toContain(
      'AssertionError',
    );
    const failures = failedTests(report, root);
    expect(failures).toHaveLength(1);
    const checked = run(root, ['scripts/check-records.ts', '--base', BASE]);
    const output = `${checked.stdout}\n${checked.stderr}`;
    expect(checked.error).toBeUndefined();
    expect(output).toContain('check-records: pass  lint ratchet');
    expect(output).toContain('check-records: pass  named suites kept');
    expect(
      checked.status,
      'A real assertion failure must exit 1, never become exit 3.\n' + output,
    ).toBe(1);
  });
}, 120_000);

it('a retry keeps an unhandled error from another file', () => {
  inClone((root) => {
    writeFileSync(
      join(root, 'tests/ci/ci-jobs-time-out.test.ts'),
      [
        "import { it } from 'vitest';",
        "it('reports an actual unhandled rejection', async () => {",
        "  void Promise.reject(new Error('SOL_REAL_UNHANDLED_FAILURE'));",
        '  await new Promise((done) => { setTimeout(done, 30); });',
        '});',
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'tests/ci/db-shards.test.ts'),
      [
        "import { it } from 'vitest';",
        "import { existsSync, writeFileSync } from 'node:fs';",
        "it('times out only on the first attempt', async () => {",
        "  if (existsSync('.records-timeout-once')) return;",
        "  writeFileSync('.records-timeout-once', 'first attempt');",
        '  await new Promise((done) => { setTimeout(done, 200); });',
        '}, 50);',
      ].join('\n'),
    );
    const child = run(root, ['scripts/check-records.ts', '--base', BASE]);
    const output = `${child.stdout}\n${child.stderr}`;
    expect(child.error).toBeUndefined();
    expect(output).toContain('SOL_REAL_UNHANDLED_FAILURE');
    expect(output).toContain('check-records: only timed out; running again alone:');
    expect(output).toContain('check-records: pass  lint ratchet');
    expect(output).toContain('check-records: pass  named suites kept');
    expect(child.status, output).toBe(1);
  });
}, 120_000);
