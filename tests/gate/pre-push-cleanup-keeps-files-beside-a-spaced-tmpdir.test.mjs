// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const hook = resolve(import.meta.dirname, '../../.husky/pre-push');

test('hook cleanup preserves unrelated files when TMPDIR contains spaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'pre-push-cleanup-'));
  const repo = join(root, 'repo');
  const sibling = join(root, 'split');
  const spaced = join(root, 'split suffix');
  const ordinary = join(root, 'ordinary');
  const marker = join(sibling, 'keep.txt');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  try {
    for (const path of [repo, sibling, spaced, ordinary]) mkdirSync(path);
    mkdirSync(join(repo, 'scripts/gate'), { recursive: true });
    mkdirSync(join(repo, 'tests/gate'), { recursive: true });
    writeFileSync(join(repo, 'scripts/gate/sweep.py'), 'import sys\nsys.exit(0)\n');
    writeFileSync(join(repo, 'scripts/public-content-check.mjs'), 'process.exit(0);\n');
    writeFileSync(join(repo, 'tests/gate/canary.txt'), 'fixture\n');
    writeFileSync(marker, 'unrelated data\n');
    git('init', '-q');
    git('config', 'user.name', 'Gate Test');
    git('config', 'user.email', 'gate@example.invalid');
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'neutral scanners');
    const sha = git('rev-parse', 'HEAD').toString().trim();
    const run = (temporary) => {
      const env = { ...process.env, TMPDIR: temporary };
      delete env.HUB_GATE_CMD;
      delete env.HUB_PUBLIC_CONTENT_CMD;
      return spawnSync('sh', ['-e', hook], {
        cwd: repo,
        env,
        encoding: 'utf8',
        input: `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`,
      });
    };
    const control = run(ordinary);
    assert.equal(control.status, 0, control.stdout + control.stderr);
    assert.ok(existsSync(marker));
    const result = run(spaced);
    assert.ok(
      existsSync(marker),
      `the hook deleted unrelated files\n${result.stdout}${result.stderr}`,
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
