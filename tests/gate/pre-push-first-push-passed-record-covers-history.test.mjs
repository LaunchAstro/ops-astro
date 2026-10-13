// SPDX-License-Identifier: AGPL-3.0-only
// A commit this machine's gate has passed narrows a later first push only if
// everything that commit reaches was really scanned, by the rules that judge
// the later push. Each test passes a commit under a condition where part of its
// history was not scanned, then first-pushes a branch built on it to another
// remote, and expects the key in that unscanned history to be refused.
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { firstPushFixture, scanned, tokenShaped } from './first-push-fixture.mjs';

const refused = (f, result, ref) => {
  assert.equal(
    result.status,
    1,
    `published the key; scanned ${scanned(result.output)}\n${result.output}`,
  );
  assert.equal(f.published('origin', ref), '');
};

test('a commit passed by its own weaker scanners does not cover its key for a push judged by stronger ones', (t) => {
  const f = firstPushFixture(t);
  assert.equal(f.push('origin', 'main').status, 0);

  // A branch whose scanners predate (or loosen) a rule: they pass anything.
  f.git('checkout', '-q', '-b', 'older-rules');
  f.commit('config.txt', `token = ${tokenShaped()}\n`, 'config');
  f.commit('scripts/public-content-check.mjs', 'process.exit(0);\n', 'content check');
  f.commit('scripts/gate/sweep.py', 'import sys\nsys.exit(0)\n', 'sweep');
  const weak = f.push('elsewhere', 'older-rules');
  assert.equal(weak.status, 0, weak.output);

  // Built on it with the current scanners back, first-pushed to origin.
  f.git('checkout', '-q', '-b', 'current-rules');
  f.git('checkout', 'main', '--', 'scripts');
  f.commit('notes.txt', 'current rules\n', 'current rules');
  refused(f, f.push('origin', 'current-rules'), 'current-rules');
});

test('a commit pushed with the scanners overridden does not cover its key for a later real push', (t) => {
  const f = firstPushFixture(t);
  f.git('checkout', '-q', '-b', 'wip');
  f.commit('config.txt', `token = ${tokenShaped()}\n`, 'config');
  // Both scanner commands replaced by `true` for one push to a scratch remote.
  const overridden = f.push('elsewhere', 'wip', { gate: 'true', publicContent: 'true' });
  assert.equal(overridden.status, 0, overridden.output);

  const tip = f.commit('notes.txt', 'later\n', 'later');
  const result = f.push('origin', 'wip');
  refused(f, result, 'wip');
  assert.deepEqual(scanned(result.output), [tip]);
});

test('a commit passed while a graft hid its parents does not cover them once the graft is gone', (t) => {
  const f = firstPushFixture(t);
  assert.equal(f.push('origin', 'main').status, 0);

  f.git('checkout', '-q', '-b', 'grafted');
  f.commit('config.txt', `token = ${tokenShaped()}\n`, 'config');
  f.commit('config.txt', null, 'drop config');
  const hidden = f.commit('notes.txt', 'grafted\n', 'notes');
  writeFileSync(join(f.repo, '.git/info/grafts'), `${hidden} ${f.base}\n`);
  const whileGrafted = f.push('elsewhere', 'grafted');
  assert.equal(whileGrafted.status, 1, whileGrafted.output);
  rmSync(join(f.repo, '.git/info/grafts'));

  f.commit('notes.txt', 'grafted\nlater\n', 'later');
  refused(f, f.push('origin', 'grafted'), 'grafted');
});
