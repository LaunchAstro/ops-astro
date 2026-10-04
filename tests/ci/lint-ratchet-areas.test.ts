// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-SCOPED: the lint ratchet with the baseline split into lint-baseline/,
// one file per area. Each case runs the real script, with the real oxlint and
// this repository's `.oxlintrc.json`, in a throwaway git repository whose
// first commit plays the base branch, as tests/ci/lint-ratchet.test.ts does.

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
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/lint-ratchet.mjs');
const RULE = 'unicorn(no-useless-undefined)';
const WEB = 'apps/web/src/a.mjs';
const PKG = 'packages/p/src/b.mjs';

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** `n` functions, each carrying one `no-useless-undefined` warning. */
const useless = (n: number) =>
  Array.from({ length: n }, (_, i) => `export function f${i}() {\n  return undefined;\n}\n`).join(
    '',
  );
const baseline = (rules: Record<string, number>) => `${JSON.stringify({ rules }, null, 2)}\n`;
const area = (name: string) => `lint-baseline/${name}.json`;

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

/** A repository whose one commit holds `files`; returns the directory and that commit. */
function repo(files: Record<string, string>): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lint-areas-ratchet-'));
  made.push(dir);
  git(dir, 'init', '-q');
  copyFileSync(join(ROOT, '.oxlintrc.json'), join(dir, '.oxlintrc.json'));
  write(dir, files);
  git(dir, 'add', '-A');
  const who = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];
  git(dir, ...who, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}

function ratchet(dir: string, base: string, ...args: string[]) {
  const env = { ...process.env, BASE_SHA: base, GITHUB_BASE_REF: '' };
  const run = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, env, encoding: 'utf8' });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

const read = (dir: string, path: string) => JSON.parse(readFileSync(join(dir, path), 'utf8'));

describe('CI-SCOPED lint ratchet per area', () => {
  it('a warning added in one area fails naming that area, even when another area has slack', () => {
    const { dir, base } = repo({
      [WEB]: useless(1),
      [PKG]: useless(1),
      [area('apps-web')]: baseline({ [RULE]: 1 }),
      [area('packages-p')]: baseline({ [RULE]: 2 }),
    });
    expect(ratchet(dir, base).status).toBe(0);

    write(dir, { [WEB]: useless(2) });
    const run = ratchet(dir, base);
    expect(run.status).toBe(1);
    expect(run.out).toContain(`new warnings in apps-web: ${RULE}: 2, baseline 1`);
    expect(run.out).not.toContain('packages-p:');
  });

  it('an area file raised above the base copy of that area file fails, and a new area counts from 0', () => {
    const { dir, base } = repo({ [WEB]: useless(1), [area('apps-web')]: baseline({ [RULE]: 1 }) });
    write(dir, {
      [area('apps-web')]: baseline({ [RULE]: 2 }),
      [area('packages-p')]: baseline({ [RULE]: 1 }),
    });
    const run = ratchet(dir, base);
    expect(run.status).toBe(1);
    expect(run.out).toContain(`lowered in apps-web: ${RULE}: 2 here, 1 on the base`);
    expect(run.out).toContain(`lowered in packages-p: ${RULE}: 1 here, 0 on the base`);
  });
});

describe('CI-SCOPED lint ratchet at the cut: the base has the single file, the head the folder', () => {
  const cut = () => {
    const fresh = repo({
      [WEB]: useless(1),
      [PKG]: useless(1),
      'lint-baseline.json': baseline({ [RULE]: 2 }),
    });
    rmSync(join(fresh.dir, 'lint-baseline.json'));
    return fresh;
  };

  it('passes when the joined totals match the base single file', () => {
    const { dir, base } = cut();
    write(dir, {
      [area('apps-web')]: baseline({ [RULE]: 1 }),
      [area('packages-p')]: baseline({ [RULE]: 1 }),
    });
    expect(ratchet(dir, base).status).toBe(0);
  });

  it('fails when any rule rises above the base single file', () => {
    const { dir, base } = cut();
    write(dir, {
      [area('apps-web')]: baseline({ [RULE]: 2 }),
      [area('packages-p')]: baseline({ [RULE]: 1 }),
    });
    const run = ratchet(dir, base);
    expect(run.status).toBe(1);
    expect(run.out).toContain(`the baseline can only be lowered: ${RULE}: 3 here, 2 on the base`);
  });
});

describe('CI-SCOPED lint ratchet --split', () => {
  it('--split writes one file per area, proves the join equals lint-baseline.json, and leaves that file alone', () => {
    const single = baseline({ [RULE]: 2 });
    const { dir, base } = repo({
      [WEB]: useless(1),
      [PKG]: useless(1),
      'lint-baseline.json': single,
    });
    const run = ratchet(dir, base, '--split');
    expect(run.status).toBe(0);
    expect(run.out).toContain('joined, they equal lint-baseline.json');
    expect(read(dir, area('apps-web'))).toEqual({ rules: { [RULE]: 1 } });
    expect(read(dir, area('packages-p'))).toEqual({ rules: { [RULE]: 1 } });
    expect(readFileSync(join(dir, 'lint-baseline.json'), 'utf8')).toBe(single);
  });

  it('--split refuses a baseline that is not tight, and writes nothing', () => {
    const { dir, base } = repo({
      [WEB]: useless(1),
      'lint-baseline.json': baseline({ [RULE]: 2 }),
    });
    const run = ratchet(dir, base, '--split');
    expect(run.status).toBe(1);
    expect(run.out).toContain('run `pnpm lint:baseline` first');
    expect(existsSync(join(dir, 'lint-baseline'))).toBe(false);
  });

  it('--split refuses when the folder already exists', () => {
    const { dir, base } = repo({
      [WEB]: useless(1),
      'lint-baseline.json': baseline({ [RULE]: 1 }),
      [area('apps-web')]: baseline({ [RULE]: 1 }),
    });
    const run = ratchet(dir, base, '--split');
    expect(run.status).toBe(1);
    expect(run.out).toContain('lint-baseline/ already exists');
  });
});

describe('CI-SCOPED lint ratchet --write with the folder', () => {
  it('--write lowers each area file, drops an area at zero, and refuses a rise in one area', () => {
    const { dir, base } = repo({
      [WEB]: useless(1),
      [PKG]: useless(2),
      [area('apps-web')]: baseline({ [RULE]: 1 }),
      [area('packages-p')]: baseline({ [RULE]: 2 }),
    });
    write(dir, { [PKG]: 'export const b = 1;\n' });
    expect(ratchet(dir, base, '--write').status).toBe(0);
    expect(existsSync(join(dir, area('packages-p')))).toBe(false);
    expect(read(dir, area('apps-web'))).toEqual({ rules: { [RULE]: 1 } });

    write(dir, { [WEB]: useless(2) });
    const run = ratchet(dir, base, '--write');
    expect(run.status).toBe(1);
    expect(run.out).toContain(`apps-web: ${RULE}: 2 here, 1 on the base`);
    expect(read(dir, area('apps-web'))).toEqual({ rules: { [RULE]: 1 } });
  });
});
