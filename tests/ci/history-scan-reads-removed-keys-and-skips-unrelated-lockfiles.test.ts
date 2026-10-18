// SPDX-License-Identifier: AGPL-3.0-only
//
// A reviewer's proofs, kept as written apart from their titles: the history
// job's lockfile step is the one on main, and the range scan still catches a
// key that a push, a merged side history or an ancestor merge removed later,
// without printing it, while a lockfile key on an unrelated branch fails
// neither step.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { ROOT, commit, detectedKey, repository, scan } from './history-scan-support.ts';

it('keeps the lockfile step as it is on main', () => {
  const base = spawnSync(
    'git',
    ['show', '889c0f0ce1d90232b11f2f2791b3126a3accf4e7:.github/workflows/ci.yml'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  expect(base.status).toBe(0);
  const old = parse(base.stdout).jobs.secrets;
  const current = parse(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')).jobs.secrets;
  expect(current.name).toBe(old.name);
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- the reviewer's proof, kept as written
  const lock = (job: typeof old) =>
    job.steps.find((s: { name?: string }) => s.name?.includes('Every version of the lockfile'));
  expect(lock(current)).toEqual(lock(old));
});

it('fails a detached push on a key main removed, and never prints it', () => {
  const { dir, git } = repository('sol-main-detached');
  const key = detectedKey();
  commit(dir, git, 'credentials.ts', key);
  git('rm', '-q', 'credentials.ts');
  git('commit', '-q', '-m', 'remove credential');
  git('checkout', '-q', '--detach');
  const result = scan(dir);
  expect(result.status).toBe(1);
  expect(result.out).toMatch(/leaks found: [1-9]/u);
  expect(result.out).not.toContain(key.slice(15, -2));
});

it('passes both steps when a lockfile key sits only on an unrelated branch', () => {
  const { dir, git } = repository('sol-unreachable-lock');
  commit(dir, git, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  git('switch', '-q', '-c', 'unrelated');
  commit(dir, git, 'pnpm-lock.yaml', detectedKey());
  git('switch', '-q', 'main');
  expect(scan(dir).status).toBe(0);
  expect(scan(dir, 'pnpm-lock.yaml').status).toBe(0);
});

it('fails on a lockfile key a merged side history deleted, and never prints it', () => {
  const { dir, git } = repository('sol-deleted-lock');
  commit(dir, git, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  git('switch', '-q', '-c', 'side');
  const key = detectedKey();
  commit(dir, git, 'pnpm-lock.yaml', key);
  git('rm', '-q', 'pnpm-lock.yaml');
  git('commit', '-q', '-m', 'remove lock');
  git('switch', '-q', 'main');
  git('merge', '-q', '--no-ff', '--no-edit', 'side');
  const result = scan(dir, 'pnpm-lock.yaml');
  expect(result.status).toBe(1);
  expect(result.out).toMatch(/leaks found: [1-9]/u);
  expect(result.out).not.toContain(key.slice(15, -2));
});

it('fails on a key only an ancestor merge added, later deleted', () => {
  const { dir, git } = repository('sol-ancestor-merge');
  git('switch', '-q', '-c', 'side');
  commit(dir, git, 'side.ts', 'export const side = 1;\n');
  git('switch', '-q', 'main');
  commit(dir, git, 'main.ts', 'export const main = 1;\n');
  git('merge', '-q', '--no-ff', '--no-commit', 'side');
  const key = detectedKey();
  writeFileSync(join(dir, 'resolution.ts'), key);
  git('add', 'resolution.ts');
  git('commit', '-q', '--no-edit');
  git('rm', '-q', 'resolution.ts');
  git('commit', '-q', '-m', 'delete resolution');
  const result = scan(dir);
  expect(result.status).toBe(1);
  expect(result.out).toMatch(/leaks found: [1-9]/u);
  expect(result.out).not.toContain(key.slice(15, -2));
});
