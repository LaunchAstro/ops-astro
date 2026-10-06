// SPDX-License-Identifier: AGPL-3.0-only
//
// The committed head, unpacked into `directory` with this checkout's
// node_modules linked in, for the coloured-summary proofs that break a copy of
// the harness and run it. `git archive` writes to a file, not a pipe into this
// process: the head's tar passed the 32 MiB spawnSync buffer these proofs held
// it in (33,556,480 bytes at main 13aa9e8 + #1091), which killed git and left
// its exit status null.

import { spawnSync } from 'node:child_process';
import { rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';

export function unpackHead(root: string, directory: string): void {
  const tarball = `${directory}.tar`;
  try {
    const archive = spawnSync('git', ['archive', '--output', tarball, 'HEAD'], { cwd: root });
    expect(archive.status, archive.stderr.toString()).toBe(0);
    const extracted = spawnSync('tar', ['-x', '-f', tarball, '-C', directory]);
    expect(extracted.status, extracted.stderr.toString()).toBe(0);
  } finally {
    rmSync(tarball, { force: true });
  }
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
}
