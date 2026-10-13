// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function -- the second model's first-push proof, kept as written */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('the first-push hook refuses a detectable credential appended to the lockfile', () => {
  const root = join(import.meta.dirname, '../..');
  const scratch = mkdtempSync(join(tmpdir(), 'proof-first-push-'));
  try {
    for (const dir of ['.husky', 'scripts', 'tests/gate'])
      mkdirSync(join(scratch, dir), { recursive: true });
    copyFileSync(join(root, '.husky/pre-push'), join(scratch, '.husky/pre-push'));
    copyFileSync(join(root, '.gitleaks.toml'), join(scratch, '.gitleaks.toml'));
    cpSync(join(root, 'scripts/gate'), join(scratch, 'scripts/gate'), { recursive: true });
    for (const file of [
      'public-content-check.mjs',
      'candidate-snapshot.mjs',
      'history-objects.mjs',
      'public-addresses.mjs',
    ])
      copyFileSync(join(root, 'scripts', file), join(scratch, 'scripts', file));
    for (const file of ['canary.txt', 'shape-canary.txt'])
      copyFileSync(join(root, 'tests/gate', file), join(scratch, 'tests/gate', file));
    const git = (...args: string[]): string => {
      const result = spawnSync('git', args, { cwd: scratch, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Synthetic review');
    git('config', 'user.email', 'proof@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    const lockfile = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
    writeFileSync(join(scratch, 'pnpm-lock.yaml'), lockfile);
    git('add', '.');
    git('commit', '-qm', 'clean control');
    const hook = () =>
      spawnSync('sh', ['-e', '.husky/pre-push'], {
        cwd: scratch,
        encoding: 'utf8',
        input: `refs/heads/main ${git('rev-parse', 'HEAD')} refs/heads/main ${'0'.repeat(40)}\n`,
        env: { PATH: process.env['PATH'], HOME: scratch },
      });
    const clean = hook();
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    const fixture = `# SERVICE_TOKEN="${'0123456789abcdef'.repeat(3)}"\n`;
    const detectable = spawnSync(
      'gitleaks',
      ['stdin', '--redact', '--exit-code', '42', '--config', '.gitleaks.toml'],
      {
        cwd: scratch,
        input: fixture,
        encoding: 'utf8',
      },
    );
    expect(detectable.status).toBe(42);
    writeFileSync(join(scratch, 'pnpm-lock.yaml'), lockfile + fixture);
    git('add', 'pnpm-lock.yaml');
    git('commit', '-qm', 'synthetic detector fixture');
    const planted = hook();
    expect(planted.status, planted.stdout + planted.stderr).not.toBe(0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  // Ten git runs, gitleaks, and the pre-push hook twice (node scripts and
  // gitleaks each time): 7.6 s on a loaded machine, past the 5 s default (#1536).
}, 30_000);
