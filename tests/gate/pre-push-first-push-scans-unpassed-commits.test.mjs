// SPDX-License-Identifier: AGPL-3.0-only
// A new branch's first push scans only the commits this machine's gate has not
// already passed, and still refuses a key in any of them. Every test pushes for
// real, through the hook, into a bare repository standing in for the remote.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const source = resolve(import.meta.dirname, '../..');
const hook = process.env.SOL_REVIEW_HOOK || join(source, '.husky/pre-push');
const realGate = `python3 ${join(source, 'scripts/gate/sweep.py')}`;
const realPublicContent = `node ${join(source, 'scripts/public-content-check.mjs')}`;
const real = { gate: realGate, publicContent: realPublicContent };

// Made-up keys, built at run time so this file never holds one.
const tokenShaped = () =>
  `${'ey'}J${randomBytes(12).toString('hex')}.${randomBytes(12).toString('hex')}`;
const githubShaped = () => {
  let body = '';
  while (body.length < 36)
    body += randomBytes(30)
      .toString('base64')
      .replaceAll(/[^A-Za-z0-9]/gu, '');
  return `${'gh'}p_${body.slice(0, 36)}`;
};

const scanned = (output) =>
  [...output.matchAll(/scanning what this push would publish: (\S+)/gu)].map((m) => m[1]);

const run = (cwd, command, args, env = process.env) =>
  spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 60000 });

const gitIn =
  (cwd) =>
  (...args) => {
    const result = run(cwd, 'git', args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  };

const identity = [
  '-c',
  'user.name=gate',
  '-c',
  'user.email=gate@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

// gate and publicContent pick the scanners; the lockfile pass is always real.
// No private list or receipt from this machine reaches the hook unless given.
const pushFrom =
  (repo) =>
  (ref, { gate = 'true', publicContent = 'true', env = {} } = {}) => {
    const inherited = { ...process.env };
    delete inherited.HUB_GATE_TERMS;
    delete inherited.HUB_GATE_LITERAL_HISTORY_RECEIPT;
    const result = run(repo, 'git', ['push', 'origin', `${ref}:refs/heads/${ref}`], {
      ...inherited,
      FIRST_PUSH_HOOK: hook,
      HUB_GATE_CMD: gate,
      HUB_PUBLIC_CONTENT_CMD: publicContent,
      ...env,
    });
    return { ...result, output: result.stdout + result.stderr };
  };

function fixture(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'first-push-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const repo = join(scratch, 'local');
  const remote = join(scratch, 'remote.git');
  const git = gitIn(repo);
  const commit = (file, text, message) => {
    writeFileSync(join(repo, file), text);
    git('add', file);
    git(...identity, 'commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const installHook = () => {
    const wrapper = join(repo, '.git/hooks/pre-push');
    writeFileSync(wrapper, '#!/bin/sh\nexec sh -e "$FIRST_PUSH_HOOK" "$@"\n');
    chmodSync(wrapper, 0o755);
  };
  const published = (ref) =>
    run(remote, 'git', ['rev-parse', '--verify', '-q', `refs/heads/${ref}`]).stdout.trim();

  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('init', '-q', '--bare', remote);
  git('remote', 'add', 'origin', remote);
  copyFileSync(join(source, '.gitleaks.toml'), join(repo, '.gitleaks.toml'));
  git('add', '.gitleaks.toml');
  commit('pnpm-lock.yaml', "lockfileVersion: '9.0'\n", 'base');
  const base = commit('notes.txt', 'base notes\n', 'notes');
  return { repo, git, commit, installHook, push: pushFrom(repo), published, scanned, base };
}

test('a clean new branch scans only its own commits, not history the gate already passed', (t) => {
  const f = fixture(t);
  f.installHook();
  const main = f.push('main');
  assert.equal(main.status, 0, main.output);
  assert.deepEqual(f.scanned(main.output), [f.base]);

  f.git('checkout', '-q', '-b', 'feature');
  f.commit('feature.txt', 'one\n', 'feature one');
  const tip = f.commit('feature.txt', 'one\ntwo\n', 'feature two');
  const result = f.push('feature');
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(f.scanned(result.output), [`${f.base}..${tip}`]);
  assert.equal(f.published('feature'), tip);
});

test('a key planted in a new commit on a new branch is refused', (t) => {
  const f = fixture(t);
  f.installHook();
  assert.equal(f.push('main', real).status, 0);

  f.git('checkout', '-q', '-b', 'leaky');
  const tip = f.commit('config.txt', `token = ${tokenShaped()}\n`, 'add config');
  const result = f.push('leaky', real);
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(f.scanned(result.output), [`${f.base}..${tip}`]);
  assert.match(result.output, /contamination in the commits you are about to publish/u);
  assert.equal(f.published('leaky'), '');
});

test('a key in the lockfile of a new commit is refused', (t) => {
  const f = fixture(t);
  f.installHook();
  assert.equal(f.push('main').status, 0);

  f.git('checkout', '-q', '-b', 'locked');
  const leaked = f.commit(
    'pnpm-lock.yaml',
    `lockfileVersion: '9.0'\n  token: ${githubShaped()}\n`,
    'lock',
  );
  const tip = f.commit('notes.txt', 'later\n', 'later');
  const result = f.push('locked');
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(f.scanned(result.output), [`${f.base}..${tip}`]);
  assert.match(result.output, new RegExp(`pnpm-lock\\.yaml at ${leaked} carries a secret`, 'u'));
  assert.equal(f.published('locked'), '');
});

test('a branch stacked on a pushed branch is refused for a key in its own new commit', (t) => {
  const f = fixture(t);
  f.installHook();
  assert.equal(f.push('main', real).status, 0);
  f.git('checkout', '-q', '-b', 'lower');
  const lower = f.commit('lower.txt', 'lower\n', 'lower');
  assert.equal(f.push('lower', real).status, 0);

  f.git('checkout', '-q', '-b', 'upper');
  const tip = f.commit('upper.txt', `token = ${tokenShaped()}\n`, 'upper');
  const result = f.push('upper', real);
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(f.scanned(result.output), [`${lower}..${tip}`]);
  assert.equal(f.published('upper'), '');
});

test('a refused commit is not passed: a clean branch built on it is still scanned from below it', (t) => {
  const f = fixture(t);
  f.installHook();
  assert.equal(f.push('main', real).status, 0);
  f.git('checkout', '-q', '-b', 'leaky');
  f.commit('config.txt', `token = ${tokenShaped()}\n`, 'add config');
  assert.equal(f.push('leaky', real).status, 1);

  f.git('checkout', '-q', '-b', 'built-on-it');
  const tip = f.commit('more.txt', 'clean\n', 'clean on top');
  const result = f.push('built-on-it', real);
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(f.scanned(result.output), [`${f.base}..${tip}`]);
  assert.equal(f.published('built-on-it'), '');
});

test('with nothing passed on this machine, a first push scans everything, even with an origin/main', (t) => {
  const f = fixture(t);
  // History reaches the remote before the hook exists here: a fresh clone
  // has the same shape, an origin/main and no commit this gate has passed.
  const dirty = f.commit('config.txt', `token = ${tokenShaped()}\n`, 'old config');
  f.git('push', '-q', 'origin', 'main');
  f.git('fetch', '-q', 'origin');
  assert.equal(f.git('rev-parse', 'refs/remotes/origin/main'), dirty);
  f.installHook();

  f.git('checkout', '-q', '-b', 'fresh');
  const tip = f.commit('fresh.txt', 'clean\n', 'fresh');
  const result = f.push('fresh', real);
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(f.scanned(result.output), [tip]);
  assert.equal(f.published('fresh'), '');
});

test('a record with one line not of its form is not trusted at all', (t) => {
  const f = fixture(t);
  f.installHook();
  assert.equal(f.push('main').status, 0);
  const record = join(
    f.git('rev-parse', '--path-format=absolute', '--git-common-dir'),
    'gate-passed',
  );
  appendFileSync(record, 'main\n');

  f.git('checkout', '-q', '-b', 'after-damage');
  const tip = f.commit('after.txt', 'clean\n', 'after damage');
  const result = f.push('after-damage');
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(f.scanned(result.output), [tip]);
});

test('a passed commit the pushed commit does not reach does not narrow its scan', (t) => {
  const f = fixture(t);
  f.git('checkout', '-q', '-b', 'side');
  f.commit('side.txt', 'side\n', 'side');
  f.installHook();
  assert.equal(f.push('side').status, 0);

  f.git('checkout', '-q', '-b', 'other', f.base);
  const tip = f.commit('other.txt', 'other\n', 'other');
  const result = f.push('other');
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(f.scanned(result.output), [tip]);
});

test('a private list that arrives after a commit passed means a full scan', (t) => {
  const f = fixture(t);
  f.installHook();
  assert.equal(f.push('main').status, 0);
  const list = join(f.repo, '..', 'terms.txt');
  writeFileSync(list, 'synthetic term\n');

  f.git('checkout', '-q', '-b', 'with-list');
  const tip = f.commit('list.txt', 'clean\n', 'with list');
  const result = f.push('with-list', { env: { HUB_GATE_TERMS: list } });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(f.scanned(result.output), [tip]);
});

test('a record that is a symlink is not trusted', (t) => {
  const f = fixture(t);
  f.installHook();
  assert.equal(f.push('main').status, 0);
  const common = f.git('rev-parse', '--path-format=absolute', '--git-common-dir');
  renameSync(join(common, 'gate-passed'), join(common, 'elsewhere'));
  symlinkSync(join(common, 'elsewhere'), join(common, 'gate-passed'));

  f.git('checkout', '-q', '-b', 'linked');
  const tip = f.commit('linked.txt', 'clean\n', 'linked');
  const result = f.push('linked');
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(f.scanned(result.output), [tip]);
});
