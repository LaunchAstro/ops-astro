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
//     check and test that failed on what it read. Exit 3 with `check-records: timed out: <names>`
//     when the only failures are tests that ran out of time, twice: a loaded machine, not a
//     verdict. The base is what the lint ratchet and the kept-suites check compare against: by
//     default the merge base of HEAD and origin/main.
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
      failureMessages?: string[];
    }[];
  }[];
};

/** A failed test: `<file> > <test>`, or the file alone when it failed with no failed test. */
export type Failure = { name: string; file: string; timedOut: boolean };

// Vitest's own message, at the start: an assertion that quotes it is not a timeout.
const TIMED_OUT = /^(?:Error: )?(?:Test|Hook) timed out in \d+ms\./u;

/**
 * Each failed test in a vitest JSON report, and a file that failed with no failed test in it (an
 * import error, a hook) as the file alone. A failure is `timedOut` when time is all it reports:
 * on a loaded machine that says nothing about the records.
 */
export function failedTests(report: Report, root: string): Failure[] {
  return (report.testResults ?? []).flatMap((result) => {
    const file = relative(root, result.name);
    const failed = (result.assertionResults ?? []).filter((a) => a.status === 'failed');
    if (failed.length > 0)
      return failed.map(({ fullName, title, failureMessages = [] }) => ({
        name: `${file} > ${fullName ?? title}`,
        file,
        timedOut: failureMessages.length > 0 && failureMessages.every((m) => TIMED_OUT.test(m)),
      }));
    return result.message ? [{ name: file, file, timedOut: TIMED_OUT.test(result.message) }] : [];
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
 * or never reached its end, is a failure on its own, never a timeout.
 */
function vitest(tests: readonly string[], env: NodeJS.ProcessEnv, alone: boolean): Failure[] {
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
    ];
    if (alone) args.push('--no-file-parallelism');
    // A test that names no timeout of its own gets longer here; one that does keeps its own.
    args.push('--testTimeout=30000', `--outputFile.json=${report}`);
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
      failures.push({ name: `record tests: ${why}`, file: '', timedOut: false });
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
  const failed: Failure[] = [];
  const steps: [string, string[]][] = [
    ['lint ratchet', [join(ROOT, 'scripts/lint-ratchet.mjs')]],
    ['named suites kept', [join(ROOT, 'scripts/named-suites.ts'), 'kept', base]],
  ];
  for (const [name, args] of steps) {
    console.log(`\n=== ${name} ===`);
    const ok = spawnSync(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' }).status === 0;
    console.log(`check-records: ${ok ? 'pass' : 'FAIL'}  ${name}`);
    if (!ok) failed.push({ name, file: '', timedOut: false });
  }
  console.log('\n=== record tests ===');
  let tests = vitest(files(), env, false);
  // Time alone is no verdict: the files that only timed out run once more, one file at a time.
  // A failure of the run itself (an unhandled error) names no file, so it is carried, not retried.
  const named = tests.filter((t) => t.file !== '');
  if (named.length > 0 && named.every((t) => t.timedOut)) {
    const again = [...new Set(named.map((t) => t.file))];
    console.log(`\ncheck-records: only timed out; running again alone: ${again.join(', ')}`);
    tests = [...tests.filter((t) => t.file === ''), ...vitest(again, env, true)];
  }
  console.log(`check-records: ${tests.length === 0 ? 'pass' : 'FAIL'}  record tests`);
  failed.push(...tests);
  const real = failed.filter((f) => !f.timedOut);
  if (real.length > 0) {
    console.log(`check-records: failed: ${real.map((f) => f.name).join('; ')}`);
    process.exit(1);
  }
  if (failed.length > 0) {
    console.log(`check-records: timed out: ${failed.map((f) => f.name).join('; ')}`);
    process.exit(3);
  }
  console.log(`check-records: every record check passed against ${base}.`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === '--list') console.log(files().join('\n'));
  else if (args.length === 0 || (args[0] === '--base' && args.length === 2)) run(baseOf(args));
  else fail('use: check-records.ts [--base <sha>] | --list');
}
