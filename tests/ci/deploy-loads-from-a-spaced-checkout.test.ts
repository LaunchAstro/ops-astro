// SPDX-License-Identifier: AGPL-3.0-only
//
// The deploy module reads its unit definition from beside itself. A checkout
// whose path holds a space must still load it: a URL's pathname keeps `%20`,
// which is not the folder's name on disk.

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const spaced = join(mkdtempSync(join(tmpdir(), 'deploy-path-')), 'ops astro');
const git = (...args: string[]) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });

afterAll(() => {
  git('worktree', 'remove', '--force', spaced);
  rmSync(resolve(spaced, '..'), { recursive: true, force: true });
});

describe('the deploy module', () => {
  it('loads from a checkout whose path holds a space', () => {
    git('worktree', 'add', '-q', '--detach', spaced, 'HEAD');
    // The module under test as it is now, not as last committed.
    copyFileSync(join(ROOT, 'scripts/ops/deploy.ts'), join(spaced, 'scripts/ops/deploy.ts'));
    const packages = git('ls-files', '--', 'package.json', '**/package.json').split('\n');
    for (const file of packages.filter(Boolean)) {
      const modules = join(dirname(file), 'node_modules');
      if (existsSync(join(ROOT, modules))) symlinkSync(join(ROOT, modules), join(spaced, modules));
    }
    const loaded = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', "await import('./scripts/ops/deploy.ts');"],
      { cwd: spaced, encoding: 'utf8' },
    );
    expect(loaded.status, loaded.stderr).toBe(0);
  }, 180_000);
});
