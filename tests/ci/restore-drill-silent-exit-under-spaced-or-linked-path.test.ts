// SPDX-License-Identifier: AGPL-3.0-only
//
// Review proof (REVIEW-MAIN-B1 p11-1): restore-drill.mjs decides it is the
// entry point with `import.meta.url === \`file://${process.argv[1]}\``. The
// URL is percent-encoded and names the real path; argv[1] is neither. So run
// from a checkout whose path holds a space, or is reached through a link,
// the command does nothing and exits 0, which its own contract reads as a
// passed drill. A bare run should print its usage and exit 2 from any path.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT = join('scripts', 'ops', 'restore-drill.mjs');

const bare = (root: string) =>
  spawnSync(process.execPath, [join(root, SCRIPT)], {
    cwd: ROOT,
    env: { PATH: process.env['PATH'] ?? '' },
    encoding: 'utf8',
  });

describe('restore-drill entry point', () => {
  it('runs (usage, exit 2) from a path with a space or through a link, never a silent exit 0', () => {
    const direct = bare(ROOT);
    expect(direct.status, 'control: the direct path prints its usage and exits 2').toBe(2);
    expect(direct.stderr).toMatch(/usage/u);

    const dir = mkdtempSync(join(tmpdir(), 'p11-1-'));
    try {
      const spaced = join(dir, 'ops astro');
      symlinkSync(ROOT, spaced);
      const run = bare(spaced);
      expect(
        { status: run.status, usage: /usage/u.test(run.stderr) },
        'restore-drill silent exit 0 under a spaced or linked path: the main-module check never matches, so --drill does nothing and reads as a pass',
      ).toStrictEqual({ status: 2, usage: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
