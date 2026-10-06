// SPDX-License-Identifier: AGPL-3.0-only
//
// The committed head, unpacked into `directory` with this checkout's
// node_modules linked in, for the coloured-summary proofs that break a copy of
// the harness and run it.

import { spawnSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';

export function unpackHead(root: string, directory: string): void {
  const archive = spawnSync('git', ['archive', 'HEAD'], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  });
  expect(archive.status, archive.stderr.toString()).toBe(0);
  const extracted = spawnSync('tar', ['-x', '-C', directory], { input: archive.stdout });
  expect(extracted.status, extracted.stderr.toString()).toBe(0);
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
}
