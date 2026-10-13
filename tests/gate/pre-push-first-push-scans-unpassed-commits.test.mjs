// SPDX-License-Identifier: AGPL-3.0-only
// A new branch's first push scans only the commits this machine's gate has not
// already passed, and still refuses a key in any of them.
import assert from 'node:assert/strict';
import { appendFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
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
  writeFileSync(list, 'synthetic unlisted phrase\n');

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
