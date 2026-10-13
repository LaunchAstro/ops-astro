// SPDX-License-Identifier: AGPL-3.0-only
//
// `lint:baseline` reads the base's baseline and this tree's warnings, then
// writes the baseline. The refusal to drop a per-area baseline the base keeps
// sits between the read and the write. A refused write must leave the files it
// found, and the same command run again once the folder is back must write it.
// The real script, the real oxlint and this repository's `.oxlintrc.json`, in a
// throwaway git repository whose first commit plays the base branch.

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const RULE = 'unicorn(no-useless-undefined)';
const WEB = 'apps/web/src/a.mjs';
const PKG = 'packages/p/src/b.mjs';

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const useless = (n: number) =>
  Array.from({ length: n }, (_, i) => `export function f${i}() {\n  return undefined;\n}\n`).join(
    '',
  );
const baseline = (rules: Record<string, number>) => `${JSON.stringify({ rules }, null, 2)}\n`;

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

function write(dir: string, files: Record<string, string>) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
}

const AREAS = {
  'lint-baseline/apps-web.json': baseline({ [RULE]: 1 }),
  'lint-baseline/packages-p.json': baseline({ [RULE]: 1 }),
};

function ratchet(dir: string, base: string) {
  const env = { ...process.env, BASE_SHA: base, GITHUB_BASE_REF: '' };
  return spawnSync(process.execPath, [join(ROOT, 'scripts/lint-ratchet.mjs'), '--write'], {
    cwd: dir,
    env,
    encoding: 'utf8',
  });
}

it('a refused baseline write leaves the files it found, and a rerun with the folder back writes it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-ratchet-refusal-'));
  made.push(dir);
  git(dir, 'init', '-q');
  copyFileSync(join(ROOT, '.oxlintrc.json'), join(dir, '.oxlintrc.json'));
  write(dir, { [WEB]: useless(1), [PKG]: useless(1), ...AREAS });
  git(dir, 'add', '-A');
  const who = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];
  git(dir, ...who, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');

  rmSync(join(dir, 'lint-baseline'), { recursive: true });
  const total = baseline({ [RULE]: 7 });
  write(dir, { 'lint-baseline.json': total });
  const refused = ratchet(dir, base);
  expect(refused.status, refused.stdout + refused.stderr).toBe(1);
  expect(refused.stdout + refused.stderr).toContain('per-area baseline');
  // Established: the refusal comes before the write, so nothing is half written.
  expect(readFileSync(join(dir, 'lint-baseline.json'), 'utf8')).toBe(total);
  expect(existsSync(join(dir, 'lint-baseline'))).toBe(false);

  rmSync(join(dir, 'lint-baseline.json'));
  write(dir, AREAS);
  const again = ratchet(dir, base);
  expect(again.status, again.stdout + again.stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(dir, 'lint-baseline/apps-web.json'), 'utf8'))).toStrictEqual({
    rules: { [RULE]: 1 },
  });
}, 120_000);
