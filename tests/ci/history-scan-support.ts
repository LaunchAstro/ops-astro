// SPDX-License-Identifier: AGPL-3.0-only
//
// Throwaway repositories for the gitleaks history job's proofs: each runs a
// step's own command, read from ci.yml, with the real gitleaks. Each key is
// made at run time and shown to gitleaks alone first, so nothing
// secret-shaped is ever committed to this repository.

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
import { afterAll, expect } from 'vitest';
import { parse } from 'yaml';

export const ROOT: string = join(import.meta.dirname, '../..');
const scratch = mkdtempSync(join(tmpdir(), 'history-scan-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const GITLEAKS = spawnSync('sh', ['-c', 'command -v gitleaks'], { encoding: 'utf8' }).stdout.trim();

/** The `run` of the history job's step whose command holds `marker`. */
export function step(marker: string): string {
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
export function detectedKey(): string {
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
export function repository(name: string): { dir: string; git: (...args: string[]) => void } {
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

export function commit(
  dir: string,
  git: (...args: string[]) => void,
  file: string,
  text: string,
): void {
  writeFileSync(join(dir, file), text);
  git('add', file);
  git('commit', '-q', '-m', `change ${file}`);
}

/** A step's exit status and output, run where the checkout left `HEAD`. */
export function scan(dir: string, marker = 'gitleaks git'): { status: number | null; out: string } {
  const run = spawnSync('bash', ['-e', '-c', step(marker)], { cwd: dir, encoding: 'utf8' });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}
