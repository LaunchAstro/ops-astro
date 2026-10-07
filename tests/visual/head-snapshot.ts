// SPDX-License-Identifier: AGPL-3.0-only
//
// The committed head, unpacked into `directory` with this checkout's
// node_modules linked in, for the coloured-summary proofs that break a copy of
// the harness and run it. `directory` must be a fresh, empty folder (a
// mkdtemp); the archive is written beside it as `<directory>.tar` and removed.
// `git archive` writes to that file, not a pipe into this process: a pipe into
// spawnSync has a buffer the repository can outgrow, and then git is killed.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';

const why = (run: SpawnSyncReturns<Buffer>): string =>
  `${String(run.error ?? '')} ${run.stderr?.toString() ?? ''}`;

export function unpackHead(root: string, directory: string): void {
  const tarball = `${directory}.tar`;
  try {
    const archive = spawnSync('git', ['archive', '--output', tarball, 'HEAD'], { cwd: root });
    expect(archive.status, why(archive)).toBe(0);
    const extracted = spawnSync('tar', ['-x', '-f', tarball, '-C', directory]);
    expect(extracted.status, why(extracted)).toBe(0);
  } finally {
    rmSync(tarball, { force: true });
  }
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
}
