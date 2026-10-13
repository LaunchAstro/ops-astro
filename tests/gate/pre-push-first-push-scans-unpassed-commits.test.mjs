// SPDX-License-Identifier: AGPL-3.0-only
// First pushes skip passed commits and still refuse new findings.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  firstPushFixture,
  githubShaped,
  installHook,
  scanned,
  tokenShaped,
} from './first-push-fixture.mjs';

const recordOf = (f) =>
  join(f.git('rev-parse', '--path-format=absolute', '--git-common-dir'), 'gate-passed');

const publicRecordOf = (f) =>
  join(f.git('rev-parse', '--path-format=absolute', '--git-common-dir'), 'gate-public-passed');

const publicFinding = () => `https://${'pitch'}.example.invalid/fixture\n`;

const inheritedFinding = (t) => {
  const f = firstPushFixture(t, { hooked: false });
  f.commit('inherited.txt', publicFinding(), 'inherited note');
  f.git('push', '-q', 'origin', 'main');
  f.git('fetch', '-q', 'origin');
  installHook(f.repo);
  f.git('checkout', '-q', '-b', 'fresh');
  return f;
};

test('a first push with one clean new commit passes an old finding identical to main without scanning old history', (t) => {
  const f = inheritedFinding(t);
  const tip = f.commit('fresh.txt', 'clean\n', 'fresh');
  const result = f.push('origin', 'fresh');
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /public-content: 1 commit\(s\)/u);
  assert.equal(f.published('origin', 'fresh'), tip);
});

test('a public finding added then deleted in new branch commits still refuses publication', (t) => {
  const f = inheritedFinding(t);
  f.commit('new.txt', publicFinding(), 'new note');
  f.commit('new.txt', null, 'remove note');
  const result = f.push('origin', 'fresh');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /new.txt \[private-pitch-url\]/u);
  assert.equal(f.published('origin', 'fresh'), '');
});

test('rewriting a passed branch scans its replacement commits and refuses a new public finding', (t) => {
  const f = inheritedFinding(t);
  f.commit('fresh.txt', 'clean\n', 'fresh');
  assert.equal(f.push('origin', 'fresh').status, 0);
  f.git('reset', '--hard', 'origin/main');
  f.commit('replacement.txt', publicFinding(), 'replacement');
  const result = f.push('elsewhere', 'fresh');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /replacement.txt \[private-pitch-url\]/u);
  assert.equal(f.published('elsewhere', 'fresh'), '');
});

test('a same-regime public receipt skips commits already passed on this machine', (t) => {
  const f = inheritedFinding(t);
  f.commit('fresh.txt', 'clean\n', 'fresh');
  assert.equal(f.push('origin', 'fresh').status, 0);
  f.git('checkout', '-q', '-b', 'again');
  const result = f.push('elsewhere', 'again');
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /public-content: 0 commit\(s\)/u);
});

for (const broken of ['malformed', 'symlink', 'unreadable']) {
  test(`a ${broken} public receipt falls back to full history and refuses the old finding`, (t) => {
    const f = inheritedFinding(t);
    f.commit('fresh.txt', 'clean\n', 'fresh');
    const record = publicRecordOf(f);
    if (broken === 'symlink') symlinkSync(join(f.scratch, 'absent'), record);
    else {
      writeFileSync(record, 'broken receipt\n');
      if (broken === 'unreadable') chmodSync(record, 0o000);
    }
    const result = f.push('origin', 'fresh');
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /inherited.txt \[private-pitch-url\]/u);
    assert.equal(f.published('origin', 'fresh'), '');
  });
}

test('missing origin/main falls back to full public history and refuses the old finding', (t) => {
  const f = inheritedFinding(t);
  f.git('update-ref', '-d', 'refs/remotes/origin/main');
  f.commit('fresh.txt', 'clean\n', 'fresh');
  const result = f.push('origin', 'fresh');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /inherited.txt \[private-pitch-url\]/u);
});

test('renaming an inherited finding gives it a new path and refuses publication', (t) => {
  const f = inheritedFinding(t);
  f.git('mv', 'inherited.txt', 'renamed.txt');
  f.commit('fresh.txt', 'clean\n', 'rename note');
  const result = f.push('origin', 'fresh');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /renamed.txt \[private-pitch-url\]/u);
});

test('a public receipt under weaker rules cannot hide an old branch finding from restored rules', (t) => {
  const f = inheritedFinding(t);
  f.commit('scripts/public-content-check.mjs', 'process.exit(0);\n', 'weaker check');
  f.commit('new.txt', publicFinding(), 'new note');
  assert.equal(f.push('origin', 'fresh').status, 0);
  f.git('checkout', 'origin/main', '--', 'scripts');
  f.commit('new.txt', null, 'restore rules and remove note');
  const result = f.push('elsewhere', 'fresh');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /new.txt \[private-pitch-url\]/u);
});

test('a failed baseline Git read falls back to full public history and refuses the old finding', (t) => {
  const f = inheritedFinding(t);
  f.commit('fresh.txt', 'clean\n', 'fresh');
  const shim = join(f.scratch, 'shim');
  mkdirSync(shim);
  const actualGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const main = f.git('rev-parse', 'origin/main');
  const marker = join(f.scratch, 'failed-once');
  const script = [
    '#!/bin/sh',
    `case "$*" in *"ls-tree -rz --full-tree ${main}"*)`,
    `  if [ ! -e '${marker}' ]; then touch '${marker}'; exit 1; fi ;;`,
    'esac',
    `exec '${actualGit}' "$@"`,
    '',
  ].join('\n');
  writeFileSync(join(shim, 'git'), script);
  chmodSync(join(shim, 'git'), 0o755);
  const result = f.push('origin', 'fresh', { env: { PATH: `${shim}:${process.env.PATH}` } });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /branch state could not be read; scanning full history/u);
  assert.match(result.output, /inherited.txt \[private-pitch-url\]/u);
});

test('a clean new branch scans only its own commits, not history the gate already passed', (t) => {
  const f = firstPushFixture(t);
  const main = f.push('origin', 'main');
  assert.equal(main.status, 0, main.output);
  assert.deepEqual(scanned(main.output), [f.base]);

  f.git('checkout', '-q', '-b', 'feature');
  f.commit('feature.txt', 'one\n', 'feature one');
  const tip = f.commit('feature.txt', 'one\ntwo\n', 'feature two');
  const result = f.push('origin', 'feature');
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(scanned(result.output), [`${f.base}..${tip}`]);
  assert.equal(f.published('origin', 'feature'), tip);
});

test('a key planted in a new commit on a new branch is refused', (t) => {
  const f = firstPushFixture(t);
  assert.equal(f.push('origin', 'main').status, 0);

  f.git('checkout', '-q', '-b', 'leaky');
  const tip = f.commit('config.txt', `token = ${tokenShaped()}\n`, 'add config');
  const result = f.push('origin', 'leaky');
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(scanned(result.output), [`${f.base}..${tip}`]);
  assert.match(result.output, /contamination in the commits you are about to publish/u);
  assert.equal(f.published('origin', 'leaky'), '');
});

test('a key in the lockfile of a new commit is refused', (t) => {
  const f = firstPushFixture(t);
  assert.equal(f.push('origin', 'main').status, 0);

  f.git('checkout', '-q', '-b', 'locked');
  const leaked = f.commit(
    'pnpm-lock.yaml',
    `lockfileVersion: '9.0'\n  token: ${githubShaped()}\n`,
    'lock',
  );
  const tip = f.commit('notes.txt', 'later\n', 'later');
  const result = f.push('origin', 'locked');
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(scanned(result.output), [`${f.base}..${tip}`]);
  assert.match(result.output, new RegExp(`pnpm-lock\\.yaml at ${leaked} carries a secret`, 'u'));
  assert.equal(f.published('origin', 'locked'), '');
});

test('a branch stacked on a pushed branch is refused for a key in its own new commit', (t) => {
  const f = firstPushFixture(t);
  assert.equal(f.push('origin', 'main').status, 0);
  f.git('checkout', '-q', '-b', 'lower');
  const lower = f.commit('lower.txt', 'lower\n', 'lower');
  assert.equal(f.push('origin', 'lower').status, 0);

  f.git('checkout', '-q', '-b', 'upper');
  const tip = f.commit('upper.txt', `token = ${tokenShaped()}\n`, 'upper');
  const result = f.push('origin', 'upper');
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(scanned(result.output), [`${lower}..${tip}`]);
  assert.equal(f.published('origin', 'upper'), '');
});

test('a refused commit is not passed: a clean branch built on it is still scanned from below it', (t) => {
  const f = firstPushFixture(t);
  assert.equal(f.push('origin', 'main').status, 0);
  f.git('checkout', '-q', '-b', 'leaky');
  f.commit('config.txt', `token = ${tokenShaped()}\n`, 'add config');
  assert.equal(f.push('origin', 'leaky').status, 1);

  f.git('checkout', '-q', '-b', 'built-on-it');
  const tip = f.commit('more.txt', 'clean\n', 'clean on top');
  const result = f.push('origin', 'built-on-it');
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(scanned(result.output), [`${f.base}..${tip}`]);
  assert.equal(f.published('origin', 'built-on-it'), '');
});

test('with nothing passed on this machine, a first push scans everything, even with an origin/main', (t) => {
  // History reaches the remote before the hook exists here: a fresh clone
  // has the same shape, an origin/main and no commit this gate has passed.
  const f = firstPushFixture(t, { hooked: false });
  const dirty = f.commit('config.txt', `token = ${tokenShaped()}\n`, 'old config');
  f.git('push', '-q', 'origin', 'main');
  f.git('fetch', '-q', 'origin');
  assert.equal(f.git('rev-parse', 'refs/remotes/origin/main'), dirty);
  installHook(f.repo);

  f.git('checkout', '-q', '-b', 'fresh');
  const tip = f.commit('fresh.txt', 'clean\n', 'fresh');
  const result = f.push('origin', 'fresh');
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(scanned(result.output), [tip]);
  assert.equal(f.published('origin', 'fresh'), '');
});

test('a record with one line not of its form is not trusted at all', (t) => {
  const f = firstPushFixture(t);
  assert.equal(f.push('origin', 'main').status, 0);
  appendFileSync(recordOf(f), 'main\n');

  f.git('checkout', '-q', '-b', 'after-damage');
  const tip = f.commit('after.txt', 'clean\n', 'after damage');
  const result = f.push('origin', 'after-damage');
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(scanned(result.output), [tip]);
});

test('a passed commit the pushed commit does not reach does not narrow its scan', (t) => {
  const f = firstPushFixture(t);
  f.git('checkout', '-q', '-b', 'side');
  f.commit('side.txt', 'side\n', 'side');
  assert.equal(f.push('origin', 'side').status, 0);

  f.git('checkout', '-q', '-b', 'other', f.base);
  const tip = f.commit('other.txt', 'other\n', 'other');
  const result = f.push('origin', 'other');
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(scanned(result.output), [tip]);
});

test('a private list that arrives after a commit passed means a full scan', (t) => {
  const f = firstPushFixture(t);
  assert.equal(f.push('origin', 'main').status, 0);
  const list = join(f.scratch, 'terms.txt');
  // Built at run time: a term written here would be found in this file's own
  // copy, which the fixture commits with the scanners.
  writeFileSync(list, `zq${randomBytes(8).toString('hex')}\n`);

  f.git('checkout', '-q', '-b', 'with-list');
  const tip = f.commit('list.txt', 'clean\n', 'with list');
  const result = f.push('origin', 'with-list', { env: { HUB_GATE_TERMS: list } });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(scanned(result.output), [tip]);
});

test('a record that is a symlink is not trusted', (t) => {
  const f = firstPushFixture(t);
  assert.equal(f.push('origin', 'main').status, 0);
  const record = recordOf(f);
  renameSync(record, `${record}.target`);
  symlinkSync(`${record}.target`, record);

  f.git('checkout', '-q', '-b', 'linked');
  const tip = f.commit('linked.txt', 'clean\n', 'linked');
  const result = f.push('origin', 'linked');
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(scanned(result.output), [tip]);
});
