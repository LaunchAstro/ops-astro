// SPDX-License-Identifier: AGPL-3.0-only
// Kept as its reviewer wrote it; only the file name and the title follow
// tests/docs/test-files-by-behaviour.test.ts.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const checker = resolve(import.meta.dirname, '../../scripts/public-content-check.mjs');
const approved = ['ada', '@', 'alpha.local'].join('');

function scan(address, scope) {
  const repo = mkdtempSync(join(tmpdir(), 'sol-1377-address-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  try {
    git('init', '-q');
    git('config', 'user.name', 'Gate Test');
    git('config', 'user.email', 'gate@example.invalid');
    if (scope === 'identity') git('config', 'user.email', address);
    writeFileSync(
      join(repo, scope === 'path' ? address : 'note.txt'),
      scope === 'blob' ? `Contact ${address}\n` : 'neutral bytes\n',
    );
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'neutral note');
    const result = spawnSync(process.execPath, [checker, '--repo', repo, '--range', 'HEAD'], {
      encoding: 'utf8',
    });
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

for (const scope of ['blob', 'path', 'identity']) {
  for (const [edge, address] of [
    ['leading', `!${approved}`],
    ['trailing', approved.replace('@', '!@')],
  ]) {
    test(`${edge} local-part punctuation cannot exempt an unlisted address in a ${scope}`, () => {
      assert.equal(scan(approved, scope).status, 0, 'the exact published address remains allowed');
      const result = scan(address, scope);
      assert.equal(result.status, 1, result.output);
      assert.ok(!result.output.includes(address), 'the contact value is withheld');
    });
  }
}

test('an unrelated plural possessive cannot exempt an unlisted complete address', () => {
  const address = `'${approved}`;
  assert.equal(scan(`${approved}; refer to the operators' guide.`, 'blob').status, 0);
  assert.equal(scan(`${address}; refer to the guide.`, 'blob').status, 1);
  const result = scan(`${address}; refer to the operators' guide.`, 'blob');
  assert.equal(result.status, 1, result.output);
  assert.ok(!result.output.includes(address), 'the contact value is withheld');
});
