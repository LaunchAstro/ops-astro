// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('docs history checks skip in a source export', () => {
  const root = join(import.meta.dirname, '../..');
  const exported = mkdtempSync(join(tmpdir(), 'cq10-history-export-'));
  try {
    const archive = execFileSync('git', ['archive', 'HEAD'], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    const unpack = spawnSync('tar', ['-x', '-C', exported], { input: archive, encoding: 'utf8' });
    expect(unpack.status, unpack.stderr).toBe(0);
    symlinkSync(join(root, 'node_modules'), join(exported, 'node_modules'));
    const run = spawnSync(
      'corepack',
      [
        'pnpm',
        'exec',
        'vitest',
        'run',
        '--root',
        exported,
        'tests/docs/source-comment-cases-kept.test.ts',
        'tests/docs/authority-proofs-and-history-docs.test.ts',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  } finally {
    rmSync(exported, { recursive: true, force: true });
  }
});
