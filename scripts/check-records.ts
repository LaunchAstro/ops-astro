// SPDX-License-Identifier: AGPL-3.0-only
// The record-keeping checks, with no database, in about a minute: `pnpm check:records`.
//
// From 1 to 13 October 2026, 37 of the 91 failed merge groups with a named test failed only on
// the repository's own records: the suite manifest, the pre-ready gate's tree steps, test-file
// naming, the shard plan and the workflows' shape. Each needed a new queue run of about 14
// minutes. The orchestrator now runs this command on a pull request merged with main as main
// stands, before queueing it (cut 2), and a lane runs it after merging main, before READY.
//
// It runs the records' own checks over the tree. It leaves out the tests that prove the checkers
// themselves (the pre-ready gate's planted worktrees, the shard timing proof); `local checks`
// still runs those. The pre-ready gate's tree steps are the lint ratchet, the suite manifest and
// the test names, so they run here directly.
//
//   node scripts/check-records.ts [--base <sha>]
//     Runs each check to the end in the working tree, with no DATABASE_URL, and prints a line per
//     check. Exit 0 when all passed. Exit 1 with `check-records: failed: <names>` naming each
//     check and test that failed, a timeout included: on a loaded machine, run it again. The base
//     is what the lint ratchet and the kept-suites check compare against: by default the merge
//     base of HEAD and origin/main.
//   node scripts/check-records.ts --list
//     Prints the test files, and fails on one that is not there.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const VITEST = join(ROOT, 'node_modules/.bin/vitest');
const SHA = /^[0-9a-f]{40}$/u;

/** The record-keeping test files, by the record each one keeps. */
export const RECORD_TESTS: Readonly<Record<string, readonly string[]>> = {
  'suite manifest': [
    'tests/db/named-suite-manifest.test.ts',
    'tests/ci/named-suites-kept-wiring.test.ts',
    'tests/ci/named-suites-per-file.test.ts',
    'tests/ci/database-only-files-run-in-a-database-suite.test.ts',
    'tests/ci/every-node-test-file-runs-somewhere.test.ts',
    'tests/ci/container-suites-run-apart.test.ts',
  ],
  'test-file naming': ['tests/docs/test-files-by-behaviour.test.ts'],
  'shard plan': [
    'tests/ci/ci-shards.test.ts',
    'tests/ci/ci-shards-workflow.test.ts',
    'tests/ci/db-shards.test.ts',
  ],
  'workflow shape': [
    'tests/ci/merge-group-jobs.test.ts',
    'tests/ci/merge-group-workflows.test.ts',
    'tests/ci/merge-group-runner.test.ts',
    'tests/ci/ci-scope.test.ts',
    'tests/ci/ci-jobs-time-out.test.ts',
  ],
};

type Report = {
  testResults?: {
    name: string;
    message?: string;
    assertionResults?: {
      status: string;
      fullName?: string;
      title: string;
    }[];
  }[];
};

/**
 * Each failed test in a vitest JSON report as `<file> > <test>`, and a file's own error (an import
 * error, a failed hook) as the file alone, beside its failed tests or without them.
 */
export function failedTests(report: Report, root: string): string[] {
  return (report.testResults ?? []).flatMap((result) => {
    const file = relative(root, result.name);
    const failed = (result.assertionResults ?? []).filter((a) => a.status === 'failed');
    const names = failed.map(({ fullName, title }) => `${file} > ${fullName ?? title}`);
    if (result.message) names.push(file);
    return names;
  });
}

const fail = (message: string): never => {
  console.error(`check-records: ${message}`);
  process.exit(2);
};

function files(): string[] {
  const all = Object.values(RECORD_TESTS).flat();
  const missing = all.filter((file) => !existsSync(join(ROOT, file)));
  if (missing.length > 0) fail(`a listed test file is not there: ${missing.join(', ')}.`);
  return all;
}

function baseOf(args: string[]): string {
  const at = args.indexOf('--base');
  const base =
    at >= 0
      ? (args[at + 1] ?? '')
      : spawnSync('git', ['merge-base', 'HEAD', 'origin/main'], {
          cwd: ROOT,
          encoding: 'utf8',
        }).stdout.trim();
  if (!SHA.test(base)) fail(`the base "${base}" is not a full commit id; pass --base <sha>.`);
  return base;
}

/**
 * This file is also the vitest reporter the run below names. Vitest's JSON report leaves out
 * unhandled errors, so this records how many the run had, and that it reached its end.
 */
export default class RunEnd {
  onTestRunEnd(_modules: unknown, unhandled: readonly unknown[]): void {
    const path = process.env['CHECK_RECORDS_RUN_END'];
    if (path) writeFileSync(path, JSON.stringify({ unhandled: unhandled.length }));
  }
}

/**
 * One vitest run of `tests`, with its failures. An unhandled error, or a run that wrote no report
 * or never reached its end, is a failure on its own.
 */
function vitest(tests: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const out = mkdtempSync(join(tmpdir(), 'check-records-'));
  const report = join(out, 'vitest.json');
  const end = join(out, 'end.json');
  try {
    const args = [
      'run',
      ...tests,
      '--reporter=default',
      '--reporter=json',
      `--reporter=${join(ROOT, 'scripts/check-records.ts')}`,
      // A test that names no timeout of its own gets longer here; one that does keeps its own.
      '--testTimeout=30000',
      `--outputFile.json=${report}`,
    ];
    const child = spawnSync(VITEST, args, {
      cwd: ROOT,
      env: { ...env, CHECK_RECORDS_RUN_END: end },
      stdio: 'inherit',
    });
    if (child.status === 0) return [];
    const failures = existsSync(report)
      ? failedTests(JSON.parse(readFileSync(report, 'utf8')) as Report, ROOT)
      : [];
    const ran = existsSync(end)
      ? (JSON.parse(readFileSync(end, 'utf8')) as { unhandled: number })
      : null;
    if (ran === null || ran.unhandled > 0 || failures.length === 0) {
      const why =
        ran === null
          ? 'the run did not reach its end'
          : ran.unhandled > 0
            ? `${ran.unhandled} unhandled error(s)`
            : 'vitest failed with no failed test';
      failures.push(`record tests: ${why}`);
    }
    return failures;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function run(base: string): void {
  const env: NodeJS.ProcessEnv = { ...process.env, BASE_SHA: base, GITHUB_BASE_REF: '' };
  delete env['DATABASE_URL'];
  delete env['DATABASE_ADMIN_URL'];
  const failed: string[] = [];
  const steps: [string, string[]][] = [
    ['lint ratchet', [join(ROOT, 'scripts/lint-ratchet.mjs')]],
    ['named suites kept', [join(ROOT, 'scripts/named-suites.ts'), 'kept', base]],
  ];
  for (const [name, args] of steps) {
    console.log(`\n=== ${name} ===`);
    const ok = spawnSync(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' }).status === 0;
    console.log(`check-records: ${ok ? 'pass' : 'FAIL'}  ${name}`);
    if (!ok) failed.push(name);
  }
  console.log('\n=== record tests ===');
  const tests = vitest(files(), env);
  console.log(`check-records: ${tests.length === 0 ? 'pass' : 'FAIL'}  record tests`);
  failed.push(...tests);
  if (failed.length > 0) {
    console.log(`check-records: failed: ${failed.join('; ')}`);
    process.exit(1);
  }
  console.log(`check-records: every record check passed against ${base}.`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === '--list') console.log(files().join('\n'));
  else if (args.length === 0 || (args[0] === '--base' && args.length === 2)) run(baseOf(args));
  else fail('use: check-records.ts [--base <sha>] | --list');
}
