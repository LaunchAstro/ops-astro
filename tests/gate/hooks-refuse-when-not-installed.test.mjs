// SPDX-License-Identifier: AGPL-3.0-only
// Git skips a hook folder that does not exist without a word, so a checkout
// whose hooks were never installed would publish with no pre-push scan. Every
// worktree of a clone shares one core.hooksPath. These cases build a clone with
// an older commit (no dispatchers) and a newer one (scripts/hook-dispatch.sh
// from this checkout), install hooks the way husky does, and push for real
// into a bare repository: a checkout without installed hooks must refuse,
// whatever commit it is on.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const source = resolve(import.meta.dirname, '../..');
const installer = join(source, 'scripts/hook-dispatch.sh');

const identity = [
  '-c',
  'user.name=gate',
  '-c',
  'user.email=gate@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

const run = (cwd, command, args) => {
  const env = { ...process.env };
  delete env.HUSKY;
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 60000 });
  return { ...result, output: result.stdout + result.stderr };
};

const gitIn =
  (cwd) =>
  (...args) => {
    const result = run(cwd, 'git', args);
    assert.equal(result.status, 0, result.output);
    return result.stdout.trim();
  };

// Each hook of the fixture leaves a marker, so a case can tell it ran.
const writeHooks = (repo, preCommit) => {
  mkdirSync(join(repo, '.husky'), { recursive: true });
  writeFileSync(
    join(repo, '.husky/pre-push'),
    'touch "$(git rev-parse --git-common-dir)/pre-push-ran"\n',
  );
  writeFileSync(join(repo, '.husky/commit-msg'), 'exit 0\n');
  writeFileSync(join(repo, '.husky/pre-commit'), preCommit);
};

// What `husky` does on install: generated hooks under .husky/_ and the shared
// core.hooksPath pointed at that relative folder.
const huskyInstall = (worktree) => {
  const generated = join(worktree, '.husky/_');
  mkdirSync(generated, { recursive: true });
  writeFileSync(
    join(generated, 'h'),
    '#!/bin/sh\n[ "${HUSKY-}" = "0" ] && exit 0\nexec sh -e "$(dirname "$(dirname "$0")")/$(basename "$0")" "$@"\n',
  );
  for (const hook of ['pre-commit', 'commit-msg', 'pre-push']) {
    writeFileSync(join(generated, hook), '#!/bin/sh\n. "$(dirname "$0")/h"\n');
    chmodSync(join(generated, hook), 0o755);
  }
  writeFileSync(join(generated, '.gitignore'), '*\n');
  gitIn(worktree)('config', 'core.hooksPath', '.husky/_');
};

// The package's prepare step on a commit that carries the installer.
const prepare = (worktree) => {
  huskyInstall(worktree);
  if (existsSync(join(worktree, 'scripts/hook-dispatch.sh'))) {
    const result = run(worktree, 'sh', ['scripts/hook-dispatch.sh']);
    assert.equal(result.status, 0, result.output);
  }
};

function clone(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'hooks-installed-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const repo = join(scratch, 'clone');
  const remote = join(scratch, 'remote.git');
  const git = gitIn(repo);
  const commit = (message) => {
    git('add', '-A');
    git(...identity, 'commit', '-q', '--no-verify', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('init', '-q', '--bare', remote);
  git('remote', 'add', 'origin', remote);
  writeHooks(repo, 'exit 0\n');
  const older = commit('hooks before the dispatchers');
  mkdirSync(join(repo, 'scripts'));
  if (existsSync(installer)) copyFileSync(installer, join(repo, 'scripts/hook-dispatch.sh'));
  writeHooks(repo, 'sh scripts/hook-dispatch.sh\n');
  const newer = commit('hooks with the dispatchers');
  const worktree = (name, at) => {
    const path = join(scratch, name);
    git('worktree', 'add', '-q', '--detach', path, at);
    return path;
  };
  const push = (from, ref) => run(from, 'git', ['push', 'origin', `HEAD:refs/heads/${ref}`]);
  const published = (ref) =>
    run(remote, 'git', ['rev-parse', '--verify', '-q', `refs/heads/${ref}`]).stdout.trim();
  const ran = () => existsSync(join(repo, '.git/pre-push-ran'));
  return { scratch, repo, git, older, newer, worktree, push, published, ran };
}

const refused = (c, result, ref) => {
  assert.notEqual(result.status, 0, `the push went through with no hook run\n${result.output}`);
  assert.match(result.output, /no installed hooks/u);
  assert.equal(c.published(ref), '');
  assert.equal(c.ran(), false);
};

test('a fresh worktree with no install refuses the push', (t) => {
  const c = clone(t);
  prepare(c.repo);
  refused(c, c.push(c.worktree('fresh', c.newer), 'fresh'), 'fresh');
});

test('a worktree on a commit from before the dispatchers refuses the push, never skips', (t) => {
  const c = clone(t);
  prepare(c.repo);
  refused(c, c.push(c.worktree('older', c.older), 'older'), 'older');
});

test('an installed worktree runs its own pre-push hook', (t) => {
  const c = clone(t);
  prepare(c.repo);
  const result = c.push(c.repo, 'installed');
  assert.equal(result.status, 0, result.output);
  assert.equal(c.ran(), true);
  assert.equal(c.published('installed'), c.newer);
});

test("an older commit's install that points hooks back at .husky/_ is undone by the next commit in an installed worktree", (t) => {
  const c = clone(t);
  prepare(c.repo);
  const older = c.worktree('older', c.older);
  prepare(older);
  assert.equal(c.git('config', 'core.hooksPath'), '.husky/_');

  writeFileSync(join(c.repo, 'note.txt'), 'note\n');
  c.git('add', 'note.txt');
  c.git(...identity, 'commit', '-q', '-m', 'note');
  assert.notEqual(c.git('config', 'core.hooksPath'), '.husky/_');
  refused(c, c.push(c.worktree('fresh', c.newer), 'fresh'), 'fresh');
});

test('the installer outside a Git checkout does nothing and succeeds', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'hooks-no-git-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const result = run(scratch, 'sh', [installer]);
  assert.equal(result.status, 0, result.output);
});

test('twelve installs at once all succeed and leave whole dispatchers', async (t) => {
  const c = clone(t);
  const { spawn } = await import('node:child_process');
  const once = () =>
    new Promise((done) => {
      const child = spawn('sh', ['scripts/hook-dispatch.sh'], { cwd: c.repo, stdio: 'ignore' });
      child.on('exit', (code) => done(code));
    });
  const codes = await Promise.all(Array.from({ length: 12 }, once));
  assert.deepEqual(
    codes,
    Array.from({ length: 12 }, () => 0),
  );
  const dispatch = join(
    c.git('rev-parse', '--path-format=absolute', '--git-common-dir'),
    'hook-dispatch',
  );
  assert.equal(c.git('config', 'core.hooksPath'), dispatch);
  for (const hook of ['pre-commit', 'commit-msg', 'pre-push']) {
    assert.equal(run(c.repo, 'sh', ['-n', join(dispatch, hook)]).status, 0, hook);
  }
  assert.deepEqual(run(c.repo, 'ls', [dispatch]).stdout.trim().split('\n').toSorted(), [
    'commit-msg',
    'pre-commit',
    'pre-push',
  ]);
});
