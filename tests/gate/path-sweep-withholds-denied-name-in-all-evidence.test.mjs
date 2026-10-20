// SPDX-License-Identifier: AGPL-3.0-only
// Kept as its reviewer wrote it; only the file name and the title follow
// tests/docs/test-files-by-behaviour.test.ts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const source = resolve(import.meta.dirname, '../..');

test('path mode withholds a denied filename in all evidence', () => {
  const repo = mkdtempSync(join(tmpdir(), 'sol-1377-path-'));
  const canary = readFileSync(join(source, 'tests/gate/canary.txt'), 'utf8').match(
    /[Kk]wathorne [A-Za-z]+ [A-Za-z]+/u,
  )?.[0];
  assert.ok(canary);
  const slug = canary.toLowerCase().replaceAll(' ', '-');
  try {
    writeFileSync(join(repo, slug), 'neutral bytes\n');
    const result = spawnSync('python3', [join(source, 'scripts/gate/sweep.py'), '--path', slug], {
      cwd: repo,
      env: { ...process.env, HUB_GATE_REPO: repo },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(
      !(result.stdout + result.stderr).includes(slug),
      'the report prints the denied filename in its scan summary',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
