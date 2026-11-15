// SPDX-License-Identifier: AGPL-3.0-only
// DECISIONS 130 (round 2026-11-14-review-tasks): a new branch's first push
// scans only the commits the push target does not already hold. Main reaches
// the remote by merges this machine never pushed, so no local receipt covers
// it and a first push used to scan all of history (about 10,900 commits, an
// hour on the M5). A commit counts as held only when it is one of the target
// remote's own tracking tips (refs/remotes/<remote>/*) and the receiver
// advertises it right now; anything else is scanned as before.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { firstPushFixture, installHook, scanned, source } from './first-push-fixture.mjs';

const canary = readFileSync(join(source, 'tests/gate/canary.txt'), 'utf8').match(
  /[Kk]wathorne [A-Za-z]+ [A-Za-z]+/u,
)?.[0];
assert.ok(canary, 'the gate canary names a denied term');

const recordOf = (f) =>
  join(f.git('rev-parse', '--path-format=absolute', '--git-common-dir'), 'gate-passed');
const recorded = (f) => {
  try {
    return readFileSync(recordOf(f), 'utf8');
  } catch {
    return '';
  }
};

/** Main on `remotes` by a push no hook judged, as a merge on the host puts it there. */
const mainElsewhere = (t, remotes, fetched) => {
  const f = firstPushFixture(t, { hooked: false });
  for (const remote of remotes) f.git('push', '-q', remote, 'main');
  // A push writes the remote's tracking ref too; only the fetched remotes keep one here.
  for (const remote of remotes) f.git('update-ref', '-d', `refs/remotes/${remote}/main`);
  for (const remote of fetched) f.git('fetch', '-q', remote);
  installHook(f.repo);
  f.git('checkout', '-q', '-b', 'fresh');
  return f;
};

test('a new branch one commit past the remote main scans that one commit', (t) => {
  const f = mainElsewhere(t, ['origin'], ['origin']);
  const tip = f.commit('fresh.txt', 'clean\n', 'fresh');
  const result = f.push('origin', 'fresh');
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(scanned(result.output), [`${f.base}..${tip}`]);
  assert.equal(f.published('origin', 'fresh'), tip);
  // History below the receiver's tip was not scanned here, so no receipt claims it.
  assert.doesNotMatch(recorded(f), new RegExp(tip, 'u'));
});

test('a denylisted blob in that one new commit is still refused', (t) => {
  const f = mainElsewhere(t, ['origin'], ['origin']);
  const tip = f.commit('notes/fresh.txt', `a note about ${canary}\n`, 'fresh');
  const result = f.push('origin', 'fresh');
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(scanned(result.output), [`${f.base}..${tip}`]);
  assert.match(result.output, /contamination in the commits you are about to publish/u);
  assert.equal(f.published('origin', 'fresh'), '');
});

test("another remote's tracking refs narrow nothing for this push target", (t) => {
  const f = mainElsewhere(t, ['origin', 'elsewhere'], ['origin']);
  const tip = f.commit('fresh.txt', 'clean\n', 'fresh');
  const result = f.push('elsewhere', 'fresh');
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(scanned(result.output), [tip]);
});

test('a tracking ref the receiver does not hold narrows nothing', (t) => {
  const f = mainElsewhere(t, ['origin'], ['origin']);
  f.git('checkout', '-q', 'main');
  const unpublished = f.commit('local.txt', 'never pushed\n', 'local only');
  f.git('update-ref', 'refs/remotes/origin/main', unpublished);
  f.git('checkout', '-q', '-b', 'later');
  const tip = f.commit('later.txt', 'clean\n', 'later');
  const result = f.push('origin', 'later');
  assert.equal(result.status, 0, result.output);
  // The receiver advertises only f.base, which is no tracking tip now: everything is scanned.
  assert.deepEqual(scanned(result.output), [tip]);
});

test('a URL rewrite rule anywhere keeps the full scan', (t) => {
  const f = mainElsewhere(t, ['origin'], ['origin']);
  f.git('config', 'url.unused-prefix:.insteadOf', 'unused-alias:');
  const tip = f.commit('fresh.txt', 'clean\n', 'fresh');
  const result = f.push('origin', 'fresh');
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(scanned(result.output), [tip]);
});
