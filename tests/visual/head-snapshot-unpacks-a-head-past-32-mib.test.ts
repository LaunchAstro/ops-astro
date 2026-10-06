// SPDX-License-Identifier: AGPL-3.0-only
//
// The coloured-summary proofs unpack the committed head. Main + #1091 made
// that head's tar 33,556,480 bytes, past the 32 MiB buffer the proofs read it
// into, and the merge queue's run killed `git archive` (exit status null). A
// head twice that size still unpacks whole.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { unpackHead } from './head-snapshot.ts';

const SIZE = 64 * 1024 * 1024;

it('the head snapshot unpacks a head whose archive is past 32 MiB', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'head-snapshot-'));
  try {
    const repo = join(scratch, 'repo');
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    writeFileSync(join(repo, 'large.bin'), Buffer.alloc(SIZE));
    const git = (...args: string[]) =>
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@local', ...args], { cwd: repo });
    expect(git('init', '-q').status).toBe(0);
    expect(git('add', 'large.bin').status).toBe(0);
    expect(git('commit', '-q', '--no-gpg-sign', '-m', 'large').status).toBe(0);

    const directory = join(scratch, 'unpacked');
    mkdirSync(directory);
    unpackHead(repo, directory);
    expect(statSync(join(directory, 'large.bin')).size).toBe(SIZE);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);
