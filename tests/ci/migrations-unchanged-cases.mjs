// SPDX-License-Identifier: AGPL-3.0-only
// The migration immutability check's own cases (CQ-11, product issue 59).
//
// Each case builds a throwaway repository with a base commit holding one
// applied migration, makes one change on a branch, and runs the real script
// against the two commits the way CI does.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repoRoot = resolve(import.meta.dirname, '../..');
const script = join(repoRoot, 'scripts/migrations-unchanged.mjs');

const APPLIED = 'create table things (id uuid primary key);\n';

/** A repository whose base commit holds `0001_things.sql`, and `change` applied on top. */
function scenario(change) {
  const dir = mkdtempSync(join(tmpdir(), 'migrations-unchanged-'));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'case',
        GIT_AUTHOR_EMAIL: 'case@example.invalid',
        GIT_COMMITTER_NAME: 'case',
        GIT_COMMITTER_EMAIL: 'case@example.invalid',
      },
    }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'migrations'));
  writeFileSync(join(dir, 'migrations', '0001_things.sql'), APPLIED);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  change(dir, git);
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', 'change');
  const head = git('rev-parse', 'HEAD');
  const run = spawnSync(process.execPath, [script], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, BASE_SHA: base, HEAD_SHA: head },
  });
  rmSync(dir, { recursive: true, force: true });
  return run;
}

test('a changed migration that is already on main fails the static check', () => {
  const run = scenario((dir) => {
    writeFileSync(join(dir, 'migrations', '0001_things.sql'), `${APPLIED}-- edited\n`);
  });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /migrations\/0001_things\.sql/u);
});

test('a deleted migration that is already on main fails the static check', () => {
  const run = scenario((_dir, git) => git('rm', '-q', 'migrations/0001_things.sql'));
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /migrations\/0001_things\.sql/u);
});

test('a renamed migration that is already on main fails the static check', () => {
  const run = scenario((_dir, git) =>
    git('mv', 'migrations/0001_things.sql', 'migrations/0001_renamed.sql'),
  );
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /migrations\/0001_things\.sql/u);
});

test('a new migration beside unchanged applied ones passes', () => {
  const run = scenario((dir) => {
    writeFileSync(join(dir, 'migrations', '0002_more.sql'), 'select 1;\n');
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('a change outside migrations passes', () => {
  const run = scenario((dir) => writeFileSync(join(dir, 'README.md'), 'changed\n'));
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('it refuses to run without both commits', () => {
  const run = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, BASE_SHA: '', HEAD_SHA: '' },
  });
  assert.equal(run.status, 2, run.stdout + run.stderr);
});
