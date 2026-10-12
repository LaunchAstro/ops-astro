// SPDX-License-Identifier: AGPL-3.0-only
// Kept as its reviewer wrote it; only the file name and the title follow
// tests/docs/test-files-by-behaviour.test.ts.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const hook = resolve(import.meta.dirname, '../../.husky/pre-push');

test('pre-push exports the original published scanners despite a local replacement commit', () => {
  const repo = mkdtempSync(join(tmpdir(), 'sol-1377-hook-'));
  const git = (...args) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  const env = { ...process.env };
  delete env.HUB_GATE_CMD;
  delete env.HUB_PUBLIC_CONTENT_CMD;
  const run = (sha) =>
    spawnSync('sh', ['-e', hook], {
      cwd: repo,
      env,
      encoding: 'utf8',
      input: `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`,
    });
  try {
    git('init', '-q');
    git('config', 'user.name', 'Gate Test');
    git('config', 'user.email', 'gate@example.invalid');
    mkdirSync(join(repo, 'scripts/gate'), { recursive: true });
    mkdirSync(join(repo, 'tests/gate'), { recursive: true });
    writeFileSync(join(repo, 'tests/gate/canary.txt'), 'fixture\n');
    writeFileSync(
      join(repo, 'scripts/gate/sweep.py'),
      "import sys\nsys.exit(1 if '--range' in sys.argv else 0)\n",
    );
    writeFileSync(join(repo, 'scripts/public-content-check.mjs'), 'process.exit(0);\n');
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'original scanners refuse');
    const original = git('rev-parse', 'HEAD');
    assert.equal(run(original).status, 1, 'the original scanner refuses without replacement');
    writeFileSync(join(repo, 'scripts/gate/sweep.py'), 'import sys\nsys.exit(0)\n');
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'replacement scanners pass');
    git('replace', original, git('rev-parse', 'HEAD'));
    const result = run(original);
    assert.equal(result.status, 1, result.stdout + result.stderr);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
