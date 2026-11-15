// SPDX-License-Identifier: AGPL-3.0-only
// #2507 (DECISIONS 130, after #2504): main reaches origin through merges this
// machine never pushed, so no gate-passed receipt covers it and a new branch's
// first push scanned all of history. scripts/gate/pass-main.sh scans
// origin/main on this machine, from the last receipt it already holds, with
// the pushed commit's own scanners, and records a receipt only when the whole
// scan is clean. A new branch's first push then narrows to the commits past
// that receipt through the hook's own first_push_range. Nothing trusts what a
// remote says it holds.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  firstPushFixture,
  hook,
  installHook,
  scanned,
  source,
  tokenShaped,
} from './first-push-fixture.mjs';

const passMain = join(source, 'scripts/gate/pass-main.sh');

const canary = readFileSync(join(source, 'tests/gate/canary.txt'), 'utf8').match(
  /[Kk]wathorne [A-Za-z]+ [A-Za-z]+/u,
)?.[0];
assert.ok(canary, 'the gate canary names a denied term');

// The settings the fixture's own pushes clear, so pass-main judges under the
// same fingerprint as those pushes.
const cleared = [
  'HUB_GATE_CMD',
  'HUB_PUBLIC_CONTENT_CMD',
  'HUB_GATE_LITERAL_HISTORY_RECEIPT',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONSTARTUP',
  'NODE_OPTIONS',
];

/** pass-main.sh in the fixture repository, with the fixture's private list. */
const receipt = (f, terms = f.terms) => {
  const env = { ...process.env, HUB_GATE_TERMS: terms, HUB_PRE_PUSH_HOOK: hook };
  for (const name of cleared) delete env[name];
  const result = spawnSync('sh', [passMain, 'origin', 'main'], {
    cwd: f.repo,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
};

const recorded = (f) => {
  const record = join(
    f.git('rev-parse', '--path-format=absolute', '--git-common-dir'),
    'gate-passed',
  );
  try {
    return readFileSync(record, 'utf8');
  } catch {
    return '';
  }
};

/** Main on origin by a push no hook judged, as a merge on the host puts it there. */
const mergedMain = (t, dirty = false) => {
  const f = firstPushFixture(t, { hooked: false });
  const old = dirty ? f.commit('config.txt', `token = ${tokenShaped()}\n`, 'old config') : f.base;
  f.git('push', '-q', 'origin', 'main');
  f.git('fetch', '-q', 'origin');
  installHook(f.repo);
  return { f, old };
};

test('a new branch one commit past a receipted main scans that one commit', (t) => {
  const { f } = mergedMain(t);
  const passed = receipt(f);
  assert.equal(passed.status, 0, passed.output);
  assert.match(recorded(f), new RegExp(`^${f.base} `, 'mu'));
  f.git('checkout', '-q', '-b', 'fresh');
  const tip = f.commit('fresh.txt', 'clean\n', 'fresh');
  const result = f.push('origin', 'fresh');
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(scanned(result.output), [`${f.base}..${tip}`]);
});

test('a denylisted blob in that one new commit is still refused', (t) => {
  const { f } = mergedMain(t);
  assert.equal(receipt(f).status, 0);
  f.git('checkout', '-q', '-b', 'fresh');
  const tip = f.commit('notes/fresh.txt', `a note about ${canary}\n`, 'fresh');
  const result = f.push('origin', 'fresh');
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(scanned(result.output), [`${f.base}..${tip}`]);
  assert.equal(f.published('origin', 'fresh'), '');
});

test('a key in main from before any receipt is found by pass-main, which records nothing', (t) => {
  const { f, old } = mergedMain(t, true);
  const passed = receipt(f);
  assert.equal(passed.status, 1, passed.output);
  assert.doesNotMatch(recorded(f), new RegExp(old, 'u'));
  // So the first push still scans everything and refuses.
  f.git('checkout', '-q', '-b', 'fresh');
  const tip = f.commit('fresh.txt', 'clean\n', 'fresh');
  const result = f.push('origin', 'fresh');
  assert.equal(result.status, 1, result.output);
  assert.deepEqual(scanned(result.output), [tip]);
});

test('a changed private list voids the receipt: the first push scans everything', (t) => {
  const { f } = mergedMain(t);
  assert.equal(receipt(f).status, 0);
  writeFileSync(f.terms, `${readFileSync(f.terms, 'utf8')}zq-another-made-up-term\n`);
  f.git('checkout', '-q', '-b', 'fresh');
  const tip = f.commit('fresh.txt', 'clean\n', 'fresh');
  const result = f.push('origin', 'fresh');
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(scanned(result.output), [tip]);
});

test('a second pass after main advances scans only the new merge', (t) => {
  const { f } = mergedMain(t);
  assert.equal(receipt(f).status, 0);
  const merged = f.commit('later.txt', 'later\n', 'a later merge');
  f.git('push', '-q', '--no-verify', 'origin', 'main');
  const passed = receipt(f);
  assert.equal(passed.status, 0, passed.output);
  assert.deepEqual(scanned(passed.output), [`${f.base}..${merged}`]);
  assert.match(recorded(f), new RegExp(`^${merged} `, 'mu'));
});
