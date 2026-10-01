// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-MAIN-B1 p11-1, the backup.mjs half: the nightly backup finds its
// entry point by real path, so run from a checkout whose path holds a space,
// or is reached through a link, it still runs. A bare run prints its usage
// and exits 2 from any path, never a silent exit 0.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT = join('scripts', 'ops', 'backup.mjs');

const bare = (root: string) =>
  spawnSync(process.execPath, [join(root, SCRIPT)], {
    cwd: ROOT,
    env: { PATH: process.env['PATH'] ?? '' },
    encoding: 'utf8',
  });

describe('backup entry point', () => {
  it('runs (usage, exit 2) from a path with a space or through a link, never a silent exit 0', () => {
    const direct = bare(ROOT);
    expect(direct.status, 'control: the direct path prints its usage and exits 2').toBe(2);
    expect(direct.stderr).toMatch(/usage/u);

    const dir = mkdtempSync(join(tmpdir(), 'p11-1-backup-'));
    try {
      const spaced = join(dir, 'ops astro');
      symlinkSync(ROOT, spaced);
      const run = bare(spaced);
      expect(
        { status: run.status, usage: /usage/u.test(run.stderr) },
        'backup silent exit 0 under a spaced or linked path: the main-module check never matches, so the nightly backup does nothing',
      ).toStrictEqual({ status: 2, usage: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
