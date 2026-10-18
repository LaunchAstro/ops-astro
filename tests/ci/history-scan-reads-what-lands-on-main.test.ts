// SPDX-License-Identifier: AGPL-3.0-only
//
// The CI history scan reads every commit that would land on main, history
// included, and nothing else: the checked-out commit and its ancestors. A
// key on a branch that commit does not reach fails no one; a key in the pull
// request's range, or one added and later removed, is caught. The CI step's
// own command, read from ci.yml, runs the real gitleaks over a throwaway
// repository. Each key is made here at run time and shown to gitleaks alone
// first, so nothing secret-shaped is ever committed to this repository.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = join(import.meta.dirname, '../..');
const scratch = mkdtempSync(join(tmpdir(), 'history-scan-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const GITLEAKS = spawnSync('sh', ['-c', 'command -v gitleaks'], { encoding: 'utf8' }).stdout.trim();

/** The `run` of the history job's step whose command holds `marker`. */
function step(marker: string): string {
  const ci = parse(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
    jobs: Record<string, { name?: string; steps: { run?: string }[] }>;
  };
  const job = Object.values(ci.jobs).find((j) => j.name === 'gitleaks over the full history');
  const run = job?.steps.find((s) => s.run?.includes(marker))?.run;
  expect(run, `the ${marker} step in the gitleaks job`).toBeTypeOf('string');
  return run ?? '';
}

/**
 * A key gitleaks detects under this repository's configuration. About one
 * random key in a hundred falls under its generic rule's entropy floor, so
 * each is shown to gitleaks alone first; ten misses is a broken scanner.
 */
function detectedKey(): string {
  for (let i = 0; i < 10; i += 1) {
    const probe = mkdtempSync(join(scratch, 'probe-'));
    const line = `SERVICE_TOKEN="${randomBytes(24).toString('hex')}"\n`;
    writeFileSync(join(probe, 'key.ts'), line);
    const config = join(ROOT, '.gitleaks.toml');
    const run = spawnSync(GITLEAKS, [
      'dir',
      '--no-banner',
      '--exit-code',
      '42',
      '--config',
      config,
      probe,
    ]);
    if (run.status === 42) return line;
  }
  throw new Error('gitleaks detected none of ten generated keys');
}

/** A repository with a clean main; `git` runs in it and fails the test on error. */
function repository(name: string): { dir: string; git: (...args: string[]) => void } {
  const dir = join(scratch, name);
  mkdirSync(dir);
  copyFileSync(join(ROOT, '.gitleaks.toml'), join(dir, '.gitleaks.toml'));
  symlinkSync(GITLEAKS, join(dir, 'gitleaks'));
  const git = (...args: string[]): void => {
    const done = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    expect(done.status, done.stderr).toBe(0);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'synthetic proof');
  git('config', 'user.email', 'proof@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  // The scanner's own link stays out of every commit.
  writeFileSync(join(dir, '.git/info/exclude'), 'gitleaks\n');
  git('add', '.gitleaks.toml');
  git('commit', '-q', '-m', 'main');
  return { dir, git };
}

function commit(dir: string, git: (...args: string[]) => void, file: string, text: string): void {
  writeFileSync(join(dir, file), text);
  git('add', file);
  git('commit', '-q', '-m', `change ${file}`);
}

/** A step's exit status and output, run where the checkout left `HEAD`. */
function scan(dir: string, marker = 'gitleaks git'): { status: number | null; out: string } {
  const run = spawnSync('bash', ['-e', '-c', step(marker)], { cwd: dir, encoding: 'utf8' });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

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

  it('fails on a lockfile key added and reverted on a side branch merged in', () => {
    const { dir, git } = repository('lockfile-side');
    const lockfile = "lockfileVersion: '9.0'\n";
    commit(dir, git, 'pnpm-lock.yaml', lockfile);
    git('switch', '-q', '-c', 'side');
    commit(dir, git, 'pnpm-lock.yaml', `${lockfile}# ${detectedKey()}`);
    commit(dir, git, 'pnpm-lock.yaml', lockfile);
    git('switch', '-q', 'main');
    git('switch', '-q', '-c', 'pull');
    git('merge', '-q', '--no-ff', '--no-edit', 'side');
    git('branch', '-D', 'side');
    expect(scan(dir, 'pnpm-lock.yaml').status).not.toBe(0);
  });
});
