// SPDX-License-Identifier: AGPL-3.0-only
//
// The migration ID check reads `migrations/` alone, as the runner does, so a
// directory named `Migrations/` or `MIGRATIONS/` went unchecked on Linux, and a
// Mac checkout folds it onto `migrations/`. The check now refuses it by name.
// The real script runs against a throwaway repository's two commits, as CI
// runs it. The files are written to the index, not the disk, since a Mac disk
// would fold the directory, which is the hole.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, '../../scripts/migration-ids.mjs');
const dir = mkdtempSync(join(tmpdir(), 'migration-ids-case-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const git = (args: readonly string[], input?: string): string =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'case',
      GIT_AUTHOR_EMAIL: 'case@example.invalid',
      GIT_COMMITTER_NAME: 'case',
      GIT_COMMITTER_EMAIL: 'case@example.invalid',
    },
  }).trim();

/** Commit `paths`, each holding one statement, through the index alone. */
const commit = (paths: readonly string[]): string => {
  const blob = git(['hash-object', '-w', '--stdin'], 'select 1;\n');
  for (const path of paths) git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
  git(['commit', '-q', '--allow-empty', '-m', 'change']);
  return git(['rev-parse', 'HEAD']);
};

it('refuses a migration in a directory named migrations in another case, naming it', () => {
  git(['init', '-q', '-b', 'main']);
  const base = commit(['migrations/0001_m.sql']);
  const head = commit(['Migrations/0002_m.sql', 'MIGRATIONS/0003_m.sql']);
  const run = spawnSync(process.execPath, [script], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, BASE_SHA: base, HEAD_SHA: head },
  });
  expect([run.status, run.stderr]).toStrictEqual([
    1,
    expect.stringContaining('Migrations/ is not migrations/ in lower case'),
  ]);
  expect(run.stderr).toContain('MIGRATIONS/ is not migrations/ in lower case');
});
