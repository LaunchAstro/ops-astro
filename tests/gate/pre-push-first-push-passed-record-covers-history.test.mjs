// SPDX-License-Identifier: AGPL-3.0-only
// A commit this machine's gate has passed narrows a later first push only if
// everything that commit reaches was really scanned, by the rules that judge
// the later push. Each test passes a commit under a condition where part of its
// history was not scanned, then first-pushes a branch built on it to another
// remote, and expects the key in that unscanned history to be refused.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { firstPushFixture, installHook, scanned, tokenShaped } from './first-push-fixture.mjs';

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

test('a failed baseline Git read falls back to full public history and refuses the old finding', (t) => {
  const f = firstPushFixture(t, { hooked: false });
  f.commit('inherited.txt', `https://${'pitch'}.example.invalid/fixture\n`, 'inherited note');
  f.git('push', '-q', 'origin', 'main');
  f.git('fetch', '-q', 'origin');
  installHook(f.repo);
  f.git('checkout', '-q', '-b', 'fresh');
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
  const actualNode = execFileSync('which', ['node'], { encoding: 'utf8' }).trim();
  // Git prepends its helper directory to the hook's PATH. Restore the shim
  // for Node's Git reads so the failure occurs in the public checker.
  writeFileSync(
    join(shim, 'node'),
    `#!/bin/sh\nPATH='${shim}':"$PATH"\nexport PATH\nexec '${actualNode}' "$@"\n`,
  );
  chmodSync(join(shim, 'node'), 0o755);
  const result = f.push('origin', 'fresh', { env: { PATH: `${shim}:${process.env.PATH}` } });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /branch state could not be read; scanning full history/u);
  assert.match(result.output, /inherited.txt \[private-pitch-url\]/u);
});
