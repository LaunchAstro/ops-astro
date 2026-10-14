// SPDX-License-Identifier: AGPL-3.0-only
// Kept as its reviewer wrote it; only the file name and the title follow
// tests/docs/test-files-by-behaviour.test.ts.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const source = resolve(import.meta.dirname, '../..');

test('uncommitted canary bytes cannot refuse a clean pushed commit', () => {
  const repo = mkdtempSync(join(tmpdir(), 'sol-1377-exemptions-'));
  const git = (...args) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  // A push without the private list is refused, so the case brings its own.
  const terms = mkdtempSync(join(tmpdir(), 'canary-terms-'));
  writeFileSync(join(terms, 'terms.txt'), 'zq-made-up-term\n');
  const env = { ...process.env, HUB_PUBLIC_CONTENT_CMD: 'true' };
  delete env.HUB_GATE_CMD;
  env.HUB_GATE_TERMS = join(terms, 'terms.txt');
  delete env.HUB_GATE_LITERAL_HISTORY_RECEIPT;
  const run = (sha) =>
    spawnSync('sh', ['-e', join(source, '.husky/pre-push')], {
      cwd: repo,
      env,
      encoding: 'utf8',
      input: `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`,
    });
  try {
    git('init', '-q');
    git('config', 'user.name', 'Gate Test');
    git('config', 'user.email', 'gate@example.invalid');
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    mkdirSync(join(repo, 'tests/gate'), { recursive: true });
    cpSync(join(source, 'scripts/gate'), join(repo, 'scripts/gate'), { recursive: true });
    for (const name of ['canary.txt', 'shape-canary.txt'])
      cpSync(join(source, 'tests/gate', name), join(repo, 'tests/gate', name));
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'approved scanner fixtures');
    const sha = git('rev-parse', 'HEAD');
    const clean = run(sha);
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    appendFileSync(join(repo, 'tests/gate/canary.txt'), '\n');
    const changed = run(sha);
    assert.equal(changed.status, 0, changed.stdout + changed.stderr);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(terms, { recursive: true, force: true });
  }
});
