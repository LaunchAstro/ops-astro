// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const checker = resolve(import.meta.dirname, '../../scripts/public-content-check.mjs');
const approved = ['ada', '@', 'alpha.local'].join('');

function scan(text, scope = 'blob') {
  const repo = mkdtempSync(join(tmpdir(), 'complete-address-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  try {
    git('init', '-q');
    git('config', 'user.name', 'Gate Test');
    git('config', 'user.email', scope === 'identity' ? text : 'gate@example.invalid');
    writeFileSync(
      join(repo, scope === 'path' ? text : 'contact.txt'),
      scope === 'blob' ? `${text}\n` : 'neutral bytes\n',
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

test('an unrelated apostrophe cannot truncate a complete contact address', () => {
  assert.equal(scan(`Contact ${approved}, please forward.`).status, 0);
  const address = `'${approved}`;
  assert.equal(scan(`Contact ${address}, please forward.`).status, 1);
  const result = scan(`Contact ${address}, don't forward.`);
  assert.equal(result.status, 1, result.output);
  assert.ok(!result.output.includes(address), 'evidence must withhold the complete contact value');
});

test('unrelated inline code cannot truncate a complete contact address', () => {
  const address = '`' + approved;
  assert.equal(scan(`Contact ${address}, please forward.`).status, 1);
  const result = scan(`Contact ${address}, run \`status\` instead.`);
  assert.equal(result.status, 1, result.output);
  assert.ok(!result.output.includes(address), 'evidence must withhold the complete contact value');
});

for (const scope of ['blob', 'path', 'identity']) {
  test(`a punctuation-only complete address remains refused in a ${scope}`, () => {
    assert.equal(scan(approved, scope).status, 0);
    const address = ['_', '@', 'alpha.local'].join('');
    const result = scan(address, scope);
    assert.equal(result.status, 1, result.output);
    assert.ok(
      !result.output.includes(address),
      'evidence must withhold the complete contact value',
    );
  });
}
