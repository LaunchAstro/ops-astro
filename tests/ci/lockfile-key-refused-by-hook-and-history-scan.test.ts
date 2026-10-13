// SPDX-License-Identifier: AGPL-3.0-only
//
// gitleaks' own default allowlist, which .gitleaks.toml extends and cannot
// narrow, skips pnpm-lock.yaml by path, so its staged and history scans never
// read a key added to the lockfile. The pre-commit hook and the CI history job
// read the lockfile's bytes through `gitleaks stdin` as well. Here the real
// hook runs on a staged lockfile, and the CI step's own command, read from
// ci.yml, runs over a history whose middle version of the lockfile carries a
// key; each beside a clean control. The key is a synthetic assignment.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = join(import.meta.dirname, '../..');
const KEY = `# SERVICE_TOKEN="${'0123456789abcdef'.repeat(3)}"\n`;
const scratch = mkdtempSync(join(tmpdir(), 'lockfile-key-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A git repository in `scratch` holding the scan's configuration. */
function repository(name: string): { dir: string; git: (...args: string[]) => string } {
  const dir = join(scratch, name);
  mkdirSync(dir);
  copyFileSync(join(ROOT, '.gitleaks.toml'), join(dir, '.gitleaks.toml'));
  const git = (...args: string[]): string => {
    const done = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    expect(done.status, done.stderr).toBe(0);
    return done.stdout;
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'synthetic proof');
  git('config', 'user.email', 'proof@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  return { dir, git };
}

/** The `run` of the CI step that scans every version of the lockfile. */
function historyStep(): string {
  const ci = parse(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
    jobs: Record<string, { name?: string; steps: { name?: string; run?: string }[] }>;
  };
  const job = Object.values(ci.jobs).find((j) => j.name === 'gitleaks over the full history');
  const step = job?.steps.find((s) => s.name?.includes('lockfile'));
  expect(step?.run, 'the lockfile step in the history job').toBeTypeOf('string');
  return step?.run ?? '';
}

/** The history step's exit status over three lockfile versions, the middle one `middle`. */
function historyScan(name: string, middle: string): number | null {
  const { dir, git } = repository(name);
  const lockfile = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
  for (const [i, text] of [lockfile, middle, lockfile].entries()) {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), text);
    git('add', '.');
    git('commit', '-q', '--allow-empty', '-m', `lockfile version ${String(i + 1)}`);
  }
  const gitleaks = spawnSync('sh', ['-c', 'command -v gitleaks'], { encoding: 'utf8' });
  symlinkSync(gitleaks.stdout.trim(), join(dir, 'gitleaks'));
  return spawnSync('bash', ['-e', '-c', historyStep()], { cwd: dir, encoding: 'utf8' }).status;
}

/** The real pre-commit hook's exit status and output with `lockfile` staged. */
function hook(name: string, lockfile: string): { status: number | null; out: string } {
  const { dir, git } = repository(name);
  mkdirSync(join(dir, '.husky'));
  copyFileSync(join(ROOT, '.husky/pre-commit'), join(dir, '.husky/pre-commit'));
  cpSync(join(ROOT, 'scripts/gate'), join(dir, 'scripts/gate'), { recursive: true });
  copyFileSync(join(ROOT, 'scripts/hook-dispatch.sh'), join(dir, 'scripts/hook-dispatch.sh'));
  mkdirSync(join(dir, 'tests/gate'), { recursive: true });
  for (const canary of ['canary.txt', 'shape-canary.txt'])
    copyFileSync(join(ROOT, 'tests/gate', canary), join(dir, 'tests/gate', canary));
  git('add', '.');
  git('commit', '-qm', 'the hook and the gate');
  writeFileSync(join(dir, 'pnpm-lock.yaml'), lockfile);
  git('add', 'pnpm-lock.yaml');
  // lint-staged and the type check are the hook's later steps, not the scan's.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'pnpm'), 0o755);
  const done = spawnSync('sh', ['-e', '.husky/pre-commit'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
  });
  return { status: done.status, out: done.stdout + done.stderr };
}

it('a key in a middle version of the lockfile fails the CI history step, and a clean history passes', () => {
  const lockfile = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
  expect(historyScan('history-clean', lockfile)).toBe(0);
  expect(historyScan('history-planted', lockfile + KEY)).not.toBe(0);
}, 60_000);

it('the pre-commit hook refuses a staged lockfile carrying a key, and passes a clean one', () => {
  const lockfile = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
  const clean = hook('hook-clean', lockfile);
  expect(clean.status, clean.out).toBe(0);
  const planted = hook('hook-planted', lockfile + KEY);
  expect(planted.status, planted.out).not.toBe(0);
  expect(planted.out).toMatch(/leaks found/u);
}, 60_000);
