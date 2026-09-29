// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const SIZER = join(import.meta.dirname, '../../scripts/pr-size.mjs');

it('a tab in a test filename does not count towards the code cap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sol-cq16-size-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Sol Proof');
    git('config', 'user.email', 'sol-proof@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'seed.txt'), 'seed\n');
    git('add', '-A');
    git('commit', '-qm', 'seed');
    const base = git('rev-parse', 'HEAD');

    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a\tb.test.ts'), 'test line\n'.repeat(401));
    git('add', '-A');
    git('commit', '-qm', 'add test file');

    const result = spawnSync('node', [SIZER], {
      cwd: dir,
      env: { ...process.env, BASE_SHA: base, HEAD_SHA: git('rev-parse', 'HEAD'), PR_LABELS: '' },
      encoding: 'utf8',
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('401 changed test lines across 1 file(s), not counted.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
