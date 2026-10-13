// SPDX-License-Identifier: AGPL-3.0-only
// A commit this machine's gate has passed narrows a later first push only if
// everything that commit reaches was really scanned, by the rules that judge
// the later push. Each test passes a commit under a condition where part of its
// history was not scanned, then first-pushes a branch built on it to another
// remote, and expects the key in that unscanned history to be refused. Every
// push is real, through the hook, into a bare repository on this machine.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const source = resolve(import.meta.dirname, '../..');
const hook = process.env.SOL_REVIEW_HOOK || join(source, '.husky/pre-push');
const realGate = `python3 ${join(source, 'scripts/gate/sweep.py')}`;
const realPublicContent = `node ${join(source, 'scripts/public-content-check.mjs')}`;
const real = { gate: realGate, publicContent: realPublicContent };

// A made-up key, built at run time so this file never holds one.
const tokenShaped = () =>
  `${'ey'}J${randomBytes(12).toString('hex')}.${randomBytes(12).toString('hex')}`;

const published = (remotePath, ref) =>
  spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${ref}`], {
    cwd: remotePath,
    encoding: 'utf8',
  }).stdout.trim();
const scanned = (output) =>
  [...output.matchAll(/scanning what this push would publish: (\S+)/gu)].map((m) => m[1]);
const identity = [
  '-c',
  'user.name=gate',
  '-c',
  'user.email=gate@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

// gate / publicContent null = leave unset, so the pushed commit's own
// scanners judge it.
const scannerEnv = ({ gate = 'true', publicContent = 'true' } = {}) => {
  const env = { ...process.env, PASSED_RECORD_HOOK: hook };
  delete env.HUB_GATE_CMD;
  delete env.HUB_PUBLIC_CONTENT_CMD;
  if (gate !== null) env.HUB_GATE_CMD = gate;
  if (publicContent !== null) env.HUB_PUBLIC_CONTENT_CMD = publicContent;
  return env;
};

function installHookIn(repo) {
  const wrapper = join(repo, '.git/hooks/pre-push');
  writeFileSync(wrapper, '#!/bin/sh\nexec sh -e "$PASSED_RECORD_HOOK" "$@"\n');
  chmodSync(wrapper, 0o755);
}

function fixture(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'passed-record-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const repo = join(scratch, 'local');
  const bare = (name) => {
    const path = join(scratch, `${name}.git`);
    spawnSync('git', ['init', '-q', '--bare', path]);
    return path;
  };
  const run = (command, args, env = process.env) =>
    spawnSync(command, args, { cwd: repo, env, encoding: 'utf8', timeout: 120000 });
  const git = (...args) => {
    const result = run('git', args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  };
  const commit = (file, text, message) => {
    if (text === null) git('rm', '-q', file);
    else {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), text);
      git('add', file);
    }
    git(...identity, 'commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const installHook = () => installHookIn(repo);
  const push = (remote, ref, scanners) => {
    const result = run('git', ['push', remote, `${ref}:refs/heads/${ref}`], scannerEnv(scanners));
    return { ...result, output: result.stdout + result.stderr };
  };
  const origin = bare('origin');
  const elsewhere = bare('elsewhere');
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', origin);
  copyFileSync(join(source, '.gitleaks.toml'), join(repo, '.gitleaks.toml'));
  git('add', '.gitleaks.toml');
  commit('pnpm-lock.yaml', "lockfileVersion: '9.0'\n", 'base');
  commit('notes.txt', 'base notes\n', 'notes');
  git('remote', 'add', 'elsewhere', elsewhere);
  return { repo, git, commit, installHook, push, published, scanned, origin, elsewhere };
}

test('a commit passed by its own weaker scanners does not cover its key for a push judged by stronger ones', (t) => {
  const f = fixture(t);
  f.installHook();
  assert.equal(f.push('origin', 'main').status, 0);

  // A branch whose scanners predate (or loosen) a rule: they pass anything.
  f.git('checkout', '-q', '-b', 'older-rules');
  f.commit('config.txt', `token = ${tokenShaped()}\n`, 'config');
  f.commit('tests/gate/canary.txt', 'fixture\n', 'canary');
  f.commit('scripts/public-content-check.mjs', 'process.exit(0);\n', 'content check');
  f.commit('scripts/gate/sweep.py', 'import sys\nsys.exit(0)\n', 'sweep');
  const weak = f.push('elsewhere', 'older-rules', { gate: null, publicContent: null });
  assert.equal(weak.status, 0, weak.output);

  // Built on it, judged by the real scanners, first-pushed to origin.
  f.git('checkout', '-q', '-b', 'current-rules');
  f.commit('scripts/gate/sweep.py', null, 'drop old sweep');
  const result = f.push('origin', 'current-rules', real);
  assert.equal(
    result.status,
    1,
    `published the key; scanned ${f.scanned(result.output)}\n${result.output}`,
  );
  assert.equal(f.published(f.origin, 'current-rules'), '');
});

test('a commit pushed with the scanners overridden does not cover its key for a later real push', (t) => {
  const f = fixture(t);
  f.installHook();
  f.git('checkout', '-q', '-b', 'wip');
  f.commit('config.txt', `token = ${tokenShaped()}\n`, 'config');
  // Both scanner commands replaced by `true` for one push to a scratch remote.
  assert.equal(f.push('elsewhere', 'wip').status, 0);

  f.commit('notes.txt', 'later\n', 'later');
  const result = f.push('origin', 'wip', real);
  assert.equal(
    result.status,
    1,
    `published the key; scanned ${f.scanned(result.output)}\n${result.output}`,
  );
  assert.equal(f.published(f.origin, 'wip'), '');
});

test('a commit passed while a graft hid its parents does not cover them once the graft is gone', (t) => {
  const f = fixture(t);
  f.installHook();
  assert.equal(f.push('origin', 'main').status, 0);
  const base = f.git('rev-parse', 'HEAD');

  f.git('checkout', '-q', '-b', 'grafted');
  f.commit('config.txt', `token = ${tokenShaped()}\n`, 'config');
  f.commit('config.txt', null, 'drop config');
  const hidden = f.commit('notes.txt', 'grafted\n', 'notes');
  writeFileSync(join(f.repo, '.git/info/grafts'), `${hidden} ${base}\n`);
  f.push('elsewhere', 'grafted', real);
  rmSync(join(f.repo, '.git/info/grafts'));

  f.commit('notes.txt', 'grafted\nlater\n', 'later');
  const result = f.push('origin', 'grafted', real);
  assert.equal(
    result.status,
    1,
    `published the key; scanned ${f.scanned(result.output)}\n${result.output}`,
  );
  assert.equal(f.published(f.origin, 'grafted'), '');
});
