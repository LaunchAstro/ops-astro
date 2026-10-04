// SPDX-License-Identifier: AGPL-3.0-only
// The split refusal test in named-suites-split.test.ts claims the refused
// command "changes nothing". This runs that exact test against a disposable
// copy whose split command first deletes, or rewrites, the only suite file
// and then refuses as usual: the test must fail both times, so a refusal
// that damages the registry on its way out cannot pass as harmless. The
// same copy without the damage must pass, so a failure for any other reason
// does not count as caught.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const SUITE = 'tests/db/suites/api/a.test.ts.json';
const BODY = JSON.stringify({ kind: 'invariant', isolation: true, why: 'fixture' });
const SELECTED =
  'split, run as a command in the repository, refuses now each suite has its own file and changes nothing';

/**
 * A disposable copy holding the split command, with `damage` run first, one
 * suite file and the refusal test. The test reads the cut parent's manifest
 * with `git show` at load, so the copy keeps the worktree's `.git` pointer;
 * the copied test runs no other git command.
 */
function copyWith(damage: string): string {
  const copy = mkdtempSync(join(tmpdir(), 'split-refusal-'));
  mkdirSync(join(copy, 'scripts'), { recursive: true });
  mkdirSync(join(copy, 'tests/ci'), { recursive: true });
  mkdirSync(join(copy, 'tests/db/suites/api'), { recursive: true });
  copyFileSync(join(ROOT, '.git'), join(copy, '.git'));
  symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'));
  writeFileSync(join(copy, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const name of ['ci-areas.ts', 'suite-files.ts']) {
    copyFileSync(join(ROOT, 'scripts', name), join(copy, 'scripts', name));
  }
  const original = readFileSync(join(ROOT, 'scripts/named-suites.ts'), 'utf8');
  const marker = 'if (import.meta.main) {';
  expect(original.split(marker)).toHaveLength(2);
  // In the disposable copy only: damage the suite file, then refuse as usual.
  writeFileSync(
    join(copy, 'scripts/named-suites.ts'),
    original.replace(marker, `${marker}\n  ${damage}`),
  );
  writeFileSync(join(copy, SUITE), BODY);
  copyFileSync(
    join(ROOT, 'tests/ci/named-suites-split.test.ts'),
    join(copy, 'tests/ci/named-suites-split.test.ts'),
  );
  writeFileSync(
    join(copy, 'vitest.config.mjs'),
    'export default { test: { include: ["tests/ci/*.test.ts"] } };\n',
  );
  return copy;
}

/** The refusal test's status when run in `copy`, with no results cache written. */
function refusalTestIn(copy: string): string | undefined {
  const report = join(copy, 'report.json');
  const run = spawnSync(
    process.execPath,
    [
      join(ROOT, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--root',
      copy,
      '--config',
      join(copy, 'vitest.config.mjs'),
      '--cache=false',
      '--reporter=json',
      `--outputFile=${report}`,
      'tests/ci/named-suites-split.test.ts',
      '-t',
      SELECTED,
    ],
    { cwd: copy, env: { ...process.env, TMPDIR: copy }, encoding: 'utf8', timeout: 60_000 },
  );
  const result = JSON.parse(readFileSync(report, 'utf8')) as {
    testResults: { assertionResults: { fullName: string; status: string }[] }[];
  };
  const assertion = result.testResults
    .flatMap((file) => file.assertionResults)
    .find((test) => test.fullName === SELECTED);
  expect(assertion, run.stdout + run.stderr).toBeDefined();
  return assertion?.status;
}

it.each([
  ['leaves alone', 'passed', '', BODY],
  ['deletes', 'failed', `rmSync(join(process.cwd(), '${SUITE}'));`, undefined],
  [
    'rewrites',
    'failed',
    `writeFileSync(join(process.cwd(), '${SUITE}'), '{"kind":"conformance"}');`,
    '{"kind":"conformance"}',
  ],
] as const)(
  'when split %s a suite file before refusing, the split refusal test has %s',
  (_, status, damage, left) => {
    const copy = copyWith(damage);
    try {
      expect(refusalTestIn(copy), 'the refusal test must catch a damaged suite file').toBe(status);
      // The damage really happened in the copy, or nothing did.
      const suiteFile = join(copy, SUITE);
      expect(existsSync(suiteFile) ? readFileSync(suiteFile, 'utf8') : undefined).toBe(left);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  },
  90_000,
);
