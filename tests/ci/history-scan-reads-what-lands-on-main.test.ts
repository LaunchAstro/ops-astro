// SPDX-License-Identifier: AGPL-3.0-only
//
// The CI history scan reads every commit that would land on main, history
// included, and nothing else: the checked-out commit and its ancestors. A
// key on a branch that commit does not reach fails no one; a key in the pull
// request's range, or one added and later removed, is caught. The CI step's
// own command, read from ci.yml, runs the real gitleaks over a throwaway
// repository. Each key is made here at run time and shown to gitleaks alone
// first, so nothing secret-shaped is ever committed to this repository.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commit, detectedKey, repository, scan } from './history-scan-support.ts';

describe('the history scan skips what cannot land on main', () => {
  it('passes a pull request when a key sits only on a branch it does not reach', () => {
    const { dir, git } = repository('other-branch');
    git('switch', '-q', '-c', 'other');
    commit(dir, git, 'fixture.ts', detectedKey());
    git('switch', '-q', 'main');
    git('switch', '-q', '-c', 'pull');
    commit(dir, git, 'clean.ts', 'export const answer = 42;\n');
    const { status, out } = scan(dir);
    expect(status, out).toBe(0);
  });
});

describe('the history scan reads every commit that would land on main', () => {
  it("fails on a key in the pull request's own commits, and never prints it", () => {
    const { dir, git } = repository('pull-range');
    git('switch', '-q', '-c', 'pull');
    const key = detectedKey();
    commit(dir, git, 'config.ts', key);
    const { status, out } = scan(dir);
    expect(status).not.toBe(0);
    expect(out).toMatch(/leaks found: [1-9]/u);
    expect(out).not.toContain(key.slice(15, -2));
  });

  it('fails on a key the pull request added and then removed', () => {
    const { dir, git } = repository('pull-removed');
    git('switch', '-q', '-c', 'pull');
    commit(dir, git, 'config.ts', detectedKey());
    commit(dir, git, 'config.ts', 'export const token = process.env.TOKEN;\n');
    expect(scan(dir).status).not.toBe(0);
  });

  it("fails on a key in main's history that main later removed", () => {
    const { dir, git } = repository('main-history');
    commit(dir, git, 'old.ts', detectedKey());
    commit(dir, git, 'old.ts', 'export {};\n');
    git('switch', '-q', '-c', 'pull');
    commit(dir, git, 'clean.ts', 'export const answer = 42;\n');
    expect(scan(dir).status).not.toBe(0);
  });

  it('fails a merge group whose combined head holds a key from an entry ahead', () => {
    const { dir, git } = repository('merge-group');
    git('switch', '-q', '-c', 'ahead');
    commit(dir, git, 'ahead.ts', detectedKey());
    git('switch', '-q', 'main');
    git('switch', '-q', '-c', 'group');
    git('merge', '-q', '--no-ff', '--no-edit', 'ahead');
    git('switch', '-q', '-c', 'behind');
    commit(dir, git, 'behind.ts', 'export const answer = 42;\n');
    git('branch', '-D', 'ahead');
    expect(scan(dir).status).not.toBe(0);
  });
});

describe('the history scan reads what a merge commit itself adds', () => {
  it('fails on a key a merge commit adds that neither parent holds', () => {
    const { dir, git } = repository('evil-merge');
    git('switch', '-q', '-c', 'side');
    commit(dir, git, 'side.ts', 'export const side = 1;\n');
    git('switch', '-q', 'main');
    git('switch', '-q', '-c', 'pull');
    commit(dir, git, 'pull.ts', 'export const pull = 1;\n');
    git('merge', '-q', '--no-ff', '--no-commit', 'side');
    writeFileSync(join(dir, 'resolved.ts'), detectedKey());
    git('add', 'resolved.ts');
    git('commit', '-q', '--no-edit');
    expect(scan(dir).status).not.toBe(0);
  });
});
