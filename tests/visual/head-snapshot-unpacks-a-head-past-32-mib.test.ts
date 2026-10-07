// SPDX-License-Identifier: AGPL-3.0-only
//
// The coloured-summary proofs unpack the committed head, and the repository
// grows: a head whose archive is twice the 32 MiB buffer the proofs once read
// it into still unpacks whole.

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
    // Git without the machine's own settings (signing, hooks, filters) or an inherited repository.
    const env = {
      PATH: process.env['PATH'],
      HOME: scratch,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const git = (...args: string[]): void => {
      const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@local', ...args], {
        cwd: repo,
        env,
        encoding: 'utf8',
      });
      expect(run.status, `git ${args.join(' ')}: ${String(run.error ?? '')} ${run.stderr}`).toBe(0);
    };
    git('init', '-q');
    git('add', 'large.bin');
    git('commit', '-q', '--no-verify', '--no-gpg-sign', '-m', 'large');

    const directory = join(scratch, 'unpacked');
    mkdirSync(directory);
    unpackHead(repo, directory);
    expect(statSync(join(directory, 'large.bin')).size).toBe(SIZE);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);
