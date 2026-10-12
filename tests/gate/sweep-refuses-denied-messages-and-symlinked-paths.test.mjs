// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const scanner = join(root, 'scripts/gate/sweep.py');
const canary = readFileSync(join(root, 'tests/gate/canary.txt'), 'utf8').match(
  /[Kk]wathorne [A-Za-z]+ [A-Za-z]+/u,
)?.[0];
assert.ok(canary);

function fixture(work) {
  const repo = mkdtempSync(join(tmpdir(), 'sweep-publication-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  const scan = (...args) =>
    spawnSync('python3', [scanner, ...args], {
      cwd: repo,
      env: { ...process.env, HUB_GATE_REPO: repo, HUB_GATE_LITERAL_HISTORY_RECEIPT: '' },
      encoding: 'utf8',
    });
  try {
    git('init', '-q');
    git('config', 'user.name', 'Gate Test');
    git('config', 'user.email', 'gate@example.invalid');
    work({ repo, git, scan });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

test('a Git display encoding cannot conceal a denied commit message', () => {
  fixture(({ repo, git, scan }) => {
    writeFileSync(join(repo, 'note.txt'), 'neutral bytes\n');
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', `a note about ${canary}`);
    const control = scan('--range', 'HEAD');
    assert.equal(control.status, 1, control.stdout + control.stderr);
    git('config', 'i18n.logOutputEncoding', 'UTF-16');
    const encoded = scan('--range', 'HEAD');
    assert.equal(encoded.status, 1, encoded.stdout + encoded.stderr);
  });
});

test('resolving a parent symlink cannot erase a denied repository path', () => {
  fixture(({ repo, scan }) => {
    mkdirSync(join(repo, 'safe'));
    mkdirSync(join(repo, 'fixtures'));
    writeFileSync(join(repo, 'safe', 'note.txt'), 'neutral bytes\n');
    symlinkSync('../safe', join(repo, 'fixtures', 'clients'));
    const results = ['fixtures/clients/note.txt', join(repo, 'fixtures/clients/note.txt')].map(
      (target) => scan('--path', target),
    );
    assert.deepEqual(
      results.map((result) => result.status),
      [1, 1],
      results.map((result) => result.stdout + result.stderr).join('\n'),
    );
  });
});
