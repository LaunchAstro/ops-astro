// SPDX-License-Identifier: AGPL-3.0-only
//
// The history job's lockfile step reads every version of pnpm-lock.yaml that
// any commit or merge on HEAD's full history wrote, each once, and fails when
// it cannot list them. Plain `git log -- <path>` prunes a merged side branch
// that left the file as one parent had it, so a key added and reverted there
// was never read; and with no pipefail, a `git log` that failed left the loop
// nothing to read, and the step passed.

import { describe, expect, it } from 'vitest';
import { commit, detectedKey, repository, scan } from './history-scan-support.ts';

const LOCKFILE = "lockfileVersion: '9.0'\n";

describe('the lockfile step reads every version on the full history', () => {
  it('fails on a lockfile key added and reverted on a side branch merged in', () => {
    const { dir, git } = repository('lockfile-side');
    commit(dir, git, 'pnpm-lock.yaml', LOCKFILE);
    git('switch', '-q', '-c', 'side');
    commit(dir, git, 'pnpm-lock.yaml', `${LOCKFILE}# ${detectedKey()}`);
    commit(dir, git, 'pnpm-lock.yaml', LOCKFILE);
    git('switch', '-q', 'main');
    git('switch', '-q', '-c', 'pull');
    git('merge', '-q', '--no-ff', '--no-edit', 'side');
    git('branch', '-D', 'side');
    expect(scan(dir, 'pnpm-lock.yaml').status).not.toBe(0);
  });

  it('passes a lockfile history that holds no key', () => {
    const { dir, git } = repository('lockfile-clean');
    commit(dir, git, 'pnpm-lock.yaml', LOCKFILE);
    commit(dir, git, 'pnpm-lock.yaml', `${LOCKFILE}importers: {}\n`);
    const { status, out } = scan(dir, 'pnpm-lock.yaml');
    expect(status, out).toBe(0);
  });
});

describe('the lockfile step fails closed', () => {
  it('fails when it finds no lockfile version to read', () => {
    const { dir } = repository('lockfile-none');
    expect(scan(dir, 'pnpm-lock.yaml').status).not.toBe(0);
  });

  it('fails when git cannot list the history', () => {
    const { dir, git } = repository('lockfile-unborn');
    commit(dir, git, 'pnpm-lock.yaml', LOCKFILE);
    // An unborn branch: `git log HEAD` exits 128 and prints nothing.
    git('switch', '-q', '--orphan', 'unborn');
    expect(scan(dir, 'pnpm-lock.yaml').status).not.toBe(0);
  });
});
