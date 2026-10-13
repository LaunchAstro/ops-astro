// SPDX-License-Identifier: AGPL-3.0-only
// A passed commit vouches for a later first push only under the same scan
// regime. Each test passes a commit holding a key while one input the scans
// depend on lets everything through, puts that input back the way a real scan
// reads it, and first-pushes a branch built on the commit to another remote.
// The key must be refused.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  firstPushFixture,
  githubShaped,
  scanned,
  source,
  tokenShaped,
} from './first-push-fixture.mjs';

const refused = (f, result, ref) => {
  assert.equal(
    result.status,
    1,
    `published the key; scanned ${scanned(result.output)}\n${result.output}`,
  );
  assert.equal(f.published('origin', ref), '');
};

const addLockfileKey = (f) =>
  f.commit('pnpm-lock.yaml', `lockfileVersion: '9.0'\n  token: ${githubShaped()}\n`, 'lock');

test('a .gitleaksignore in the checkout during one push does not vouch for a later push without it', (t) => {
  const f = firstPushFixture(t);
  f.git('checkout', '-q', '-b', 'locked');
  addLockfileKey(f);
  // Untracked, in the checkout: gitleaks reads it from the working directory.
  writeFileSync(join(f.repo, '.gitleaksignore'), ':github-pat:2\n');
  const ignored = f.push('elsewhere', 'locked');
  assert.equal(ignored.status, 0, ignored.output);
  rmSync(join(f.repo, '.gitleaksignore'));

  f.commit('notes.txt', 'later\n', 'later');
  refused(f, f.push('origin', 'locked'), 'locked');
});

test('a gitleaks config the checkout extends does not vouch once it changes', (t) => {
  const f = firstPushFixture(t, { gitleaksConfig: '[extend]\npath = "gitleaks-local.toml"\n' });
  const extended = join(f.repo, 'gitleaks-local.toml');
  writeFileSync(extended, '[extend]\nuseDefault = true\n[allowlist]\nregexes = ["."]\n');
  f.git('checkout', '-q', '-b', 'locked');
  addLockfileKey(f);
  const loose = f.push('elsewhere', 'locked');
  assert.equal(loose.status, 0, loose.output);

  // The checkout's own .gitleaks.toml is unchanged; only the file it extends.
  writeFileSync(extended, '[extend]\nuseDefault = true\n');
  f.commit('notes.txt', 'later\n', 'later');
  refused(f, f.push('origin', 'locked'), 'locked');
});

test('a quoted TOML extend path cannot cache a scan that skips a credential', (t) => {
  const f = firstPushFixture(t, {
    gitleaksConfig: '[extend]\n"path" = "gitleaks-local.toml"\n',
  });
  const extended = join(f.repo, 'gitleaks-local.toml');
  writeFileSync(extended, '[extend]\nuseDefault = true\n[allowlist]\nregexes = ["."]\n');
  f.git('checkout', '-q', '-b', 'locked');
  f.commit('pnpm-lock.yaml', `lockfileVersion: '9.0'\n  token: ${githubShaped()}\n`, 'lock');
  const loose = f.push('elsewhere', 'locked');
  assert.equal(loose.status, 0, loose.output);

  // Same top-level config, now a strict external rule set. The remote is fresh.
  writeFileSync(extended, '[extend]\nuseDefault = true\n');
  const tip = f.commit('notes.txt', 'later\n', 'later');
  const result = f.push('origin', 'locked');
  assert.equal(
    result.status,
    1,
    `credential-bearing history was published; scanned ${scanned(result.output)}\n${result.output}`,
  );
  assert.equal(f.published('origin', 'locked'), '');
  assert.deepEqual(scanned(result.output), [tip]);
});

// Every spelling gitleaks reads as an extend path: TOML's key forms, and the
// loader's case-insensitive, dot-splitting key match.
for (const config of [
  "[extend]\n'path' = 'gitleaks-local.toml'\n",
  'extend.path = "gitleaks-local.toml"\n',
  '"extend"."path" = "gitleaks-local.toml"\n',
  '"extend.path" = "gitleaks-local.toml"\n',
  '[ extend ]\n  path="gitleaks-local.toml"\n',
  '[EXTEND]\nPATH = "gitleaks-local.toml"\n',
  '[extend]\n"\\u0070ath" = "gitleaks-local.toml"\n',
  'extend = { path = "gitleaks-local.toml" }\n',
]) {
  test(`an extend path written ${JSON.stringify(config)} does not vouch once its file changes`, (t) => {
    const f = firstPushFixture(t, { gitleaksConfig: config });
    const extended = join(f.repo, 'gitleaks-local.toml');
    writeFileSync(extended, '[extend]\nuseDefault = true\n[allowlist]\nregexes = ["."]\n');
    f.git('checkout', '-q', '-b', 'locked');
    addLockfileKey(f);
    const loose = f.push('elsewhere', 'locked');
    assert.equal(loose.status, 0, loose.output);

    writeFileSync(extended, '[extend]\nuseDefault = true\n');
    f.commit('notes.txt', 'later\n', 'later');
    refused(f, f.push('origin', 'locked'), 'locked');
  });
}

test('a scanner command whose file changes does not vouch under its unchanged command line', (t) => {
  const f = firstPushFixture(t);
  const gateFile = join(f.scratch, 'gate.sh');
  const contentFile = join(f.scratch, 'content.sh');
  const commands = { gate: `sh ${gateFile}`, publicContent: `sh ${contentFile}` };
  writeFileSync(gateFile, 'exit 0\n');
  writeFileSync(contentFile, 'exit 0\n');
  f.git('checkout', '-q', '-b', 'wip');
  f.commit('config.txt', `token = ${tokenShaped()}\n`, 'config');
  assert.equal(f.push('elsewhere', 'wip', commands).status, 0);

  writeFileSync(gateFile, `exec python3 ${join(source, 'scripts/gate/sweep.py')} "$@"\n`);
  writeFileSync(
    contentFile,
    `exec node ${join(source, 'scripts/public-content-check.mjs')} "$@"\n`,
  );
  f.commit('notes.txt', 'later\n', 'later');
  refused(f, f.push('origin', 'wip', commands), 'wip');
});

test('python and node start-up settings during one push do not vouch for a later push without them', (t) => {
  const f = firstPushFixture(t);
  const startup = join(f.scratch, 'startup');
  mkdirSync(startup);
  writeFileSync(join(startup, 'sitecustomize.py'), 'import os\nos._exit(0)\n');
  writeFileSync(join(startup, 'exit.cjs'), 'process.exit(0);\n');
  f.git('checkout', '-q', '-b', 'wip');
  f.commit('config.txt', `token = ${tokenShaped()}\n`, 'config');
  const first = f.push('elsewhere', 'wip', {
    env: { PYTHONPATH: startup, NODE_OPTIONS: `--require ${join(startup, 'exit.cjs')}` },
  });
  assert.equal(first.status, 0, first.output);

  f.commit('notes.txt', 'later\n', 'later');
  refused(f, f.push('origin', 'wip'), 'wip');
});

test('a helper earlier on PATH during one push does not vouch for a later push without it', (t) => {
  const f = firstPushFixture(t);
  const shim = join(f.scratch, 'shim');
  mkdirSync(shim);
  // Unpacks the pushed commit's scanners, then swaps two of them for ones
  // that pass everything.
  writeFileSync(
    join(shim, 'tar'),
    [
      '#!/bin/sh',
      '/usr/bin/tar "$@" || exit',
      'dest=""',
      'prev=""',
      'for a in "$@"; do',
      '  [ "$prev" = "-C" ] && dest=$a',
      '  prev=$a',
      'done',
      '[ -n "$dest" ] || exit 0',
      'printf "import sys\\nsys.exit(0)\\n" > "$dest/scripts/gate/sweep.py"',
      'printf "process.exit(0)\\n" > "$dest/scripts/public-content-check.mjs"',
      '',
    ].join('\n'),
  );
  chmodSync(join(shim, 'tar'), 0o755);
  f.git('checkout', '-q', '-b', 'wip');
  f.commit('config.txt', `token = ${tokenShaped()}\n`, 'config');
  const first = f.push('elsewhere', 'wip', { env: { PATH: `${shim}:${process.env.PATH}` } });
  assert.equal(first.status, 0, first.output);

  f.commit('notes.txt', 'later\n', 'later');
  refused(f, f.push('origin', 'wip'), 'wip');
});
