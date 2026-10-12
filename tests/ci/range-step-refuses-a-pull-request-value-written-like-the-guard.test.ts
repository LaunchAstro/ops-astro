// SPDX-License-Identifier: AGPL-3.0-only
// A step that reads the pull request range never reads a pull request value, even one written in
// the guard's words: merge-group-workflows.test.ts sets aside the exact job-level guard line alone.
// The proof edits a throwaway copy of the workflows and runs that test there.
import { spawnSync } from 'node:child_process';
import {
  cpSync,
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
import { OPEN_GUARD } from './open-pull-request.ts';

const ROOT = join(import.meta.dirname, '../..');
const CI = '.github/workflows/ci.yml';
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const TEST = 'tests/ci/merge-group-workflows.test.ts';
const NAME =
  'every step that reads the pull request range runs once per pull request, on a pull request and on a group';

/** A throwaway copy of the workflows and the range test, run against `mutate(ci.yml)`. */
function runRangeTest(mutate: (ci: string) => string) {
  const dir = mkdtempSync(join(tmpdir(), 'range-guard-'));
  try {
    mkdirSync(join(dir, 'tests/ci'), { recursive: true });
    cpSync(join(ROOT, '.github'), join(dir, '.github'), { recursive: true });
    for (const file of ['merge-group-repo.ts', 'workflow-text.ts', 'open-pull-request.ts'])
      cpSync(join(ROOT, 'tests/ci', file), join(dir, 'tests/ci', file));
    writeFileSync(join(dir, TEST), readFileSync(join(ROOT, TEST), 'utf8'));
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
    symlinkSync(join(ROOT, 'scripts'), join(dir, 'scripts'));
    writeFileSync(
      join(dir, 'proof.config.mjs'),
      `export default { test: { include: [${JSON.stringify(TEST)}] } };\n`,
    );
    const ciPath = join(dir, '.github/workflows/ci.yml');
    writeFileSync(ciPath, mutate(readFileSync(ciPath, 'utf8')));
    const vitest = join(ROOT, 'node_modules/vitest/vitest.mjs');
    const out = spawnSync(
      process.execPath,
      [vitest, 'run', '--config', 'proof.config.mjs', TEST, '-t', NAME],
      {
        cwd: dir,
        env: { ...process.env, TMPDIR: dir, NO_COLOR: '1' },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    return { status: out.status, output: out.stdout + out.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FROM = 'BASE_SHA="$(node scripts/merge-group.mjs base)" HEAD_SHA=';

it('the range test refuses a pull request value written like the guard inside a BASE_SHA', () => {
  expect(read(CI).split(FROM)).toHaveLength(2);
  // The workflows as they stand, job guards included, pass.
  const clean = runRangeTest((ci) => ci);
  expect(clean.status, clean.output).toBe(0);
  // A guard-like value in the migration-ID step's base is refused by name, not erased.
  const mangled = `(${OPEN_GUARD}) || true`;
  const planted = runRangeTest((ci) =>
    ci.replace(FROM, `BASE_SHA="$(node scripts/merge-group.mjs base)\${{ ${mangled} }}" HEAD_SHA=`),
  );
  expect(planted.status, planted.output).toBe(1);
  expect(planted.output).toContain('github.event.pull_request.');
}, 120_000);
