// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-12: the lint ratchet. Each case is named after a line of the ticket's supporting checklist
// and runs the real script, with the real oxlint and this repository's `.oxlintrc.json`, in a
// throwaway git repository whose first commit plays the base branch.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/lint-ratchet.mjs');
const BASELINE = 'lint-baseline.json';
const RULE = 'unicorn(no-useless-undefined)';
const OTHER = 'eslint(no-negated-condition)';
const MAX = 'eslint(max-lines)';

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** `n` functions, each carrying one `no-useless-undefined` warning. */
const useless = (n: number) =>
  Array.from({ length: n }, (_, i) => `export function f${i}() {\n  return undefined;\n}\n`).join(
    '',
  );

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

function write(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** A repository whose one commit holds `files`; returns the directory and that commit. */
function repo(files: Record<string, string>): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cq12-ratchet-'));
  made.push(dir);
  git(dir, 'init', '-q');
  copyFileSync(join(ROOT, '.oxlintrc.json'), join(dir, '.oxlintrc.json'));
  write(dir, files);
  git(dir, 'add', '-A');
  git(
    dir,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'base',
  );
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}

function ratchet(dir: string, base: string, ...args: string[]) {
  const env = { ...process.env, BASE_SHA: base, GITHUB_BASE_REF: '' };
  const run = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, env, encoding: 'utf8' });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

const baseline = (rules: Record<string, number>) => `${JSON.stringify({ rules }, null, 2)}\n`;
const readBaseline = (dir: string) =>
  JSON.parse(readFileSync(join(dir, BASELINE), 'utf8')) as { rules: Record<string, number> };

describe('CQ-12 CI fails, by a named case, when a change adds one pedantic warning of any rule', () => {
  it('CQ-12 adds one warning: one more of a recorded rule fails, naming the rule and both counts', () => {
    const { dir, base } = repo({ 'src/a.mjs': useless(2), [BASELINE]: baseline({ [RULE]: 2 }) });
    expect(ratchet(dir, base).status).toBe(0);

    write(dir, { 'src/a.mjs': useless(3) });
    const run = ratchet(dir, base);
    expect(run.status).toBe(1);
    expect(run.out).toContain(`${RULE}: 3, baseline 2`);
  });

  it('CQ-12 adds one warning: the first warning of a rule the baseline does not hold fails', () => {
    const { dir, base } = repo({ 'src/a.mjs': useless(1), [BASELINE]: baseline({ [RULE]: 1 }) });
    write(dir, {
      'src/b.mjs': 'export const g = (a) => {\n  if (!a) return 1;\n  else return 2;\n};\n',
    });
    const run = ratchet(dir, base);
    expect(run.status).toBe(1);
    expect(run.out).toContain(`${OTHER}: 1, baseline 0`);
  });

  it('CQ-12 adds one warning: the ratchet prints its current numbers per rule and in total', () => {
    const { dir, base } = repo({ 'src/a.mjs': useless(2), [BASELINE]: baseline({ [RULE]: 2 }) });
    const run = ratchet(dir, base);
    expect(run.out).toMatch(/2\s+2\s+unicorn\(no-useless-undefined\)/u);
    expect(run.out).toMatch(/total: 2 warnings, baseline 2/u);
  });

  it('CQ-12 adds one warning: a run that lints no file fails rather than passing empty', () => {
    const { dir, base } = repo({ [BASELINE]: baseline({}) });
    const run = ratchet(dir, base);
    expect(run.status).toBe(1);
    expect(run.out).toContain('linted no file');
  });

  it('CQ-12 adds one warning: a missing baseline fails and says how to write one', () => {
    const { dir, base } = repo({ 'src/a.mjs': useless(1) });
    const run = ratchet(dir, base);
    expect(run.status).toBe(1);
    expect(run.out).toContain('pnpm lint:baseline');
  });
});

describe('CQ-12 CI passes when a change removes warnings', () => {
  it('CQ-12 removes warnings: fewer warnings than the baseline pass, and the run says the baseline can fall', () => {
    const { dir, base } = repo({ 'src/a.mjs': useless(3), [BASELINE]: baseline({ [RULE]: 3 }) });
    write(dir, { 'src/a.mjs': useless(1) });
    const run = ratchet(dir, base);
    expect(run.status).toBe(0);
    expect(run.out).toContain('pnpm lint:baseline');
  });

  it('CQ-12 removes warnings: writing the baseline lowers it to the new counts and drops a rule at zero', () => {
    const { dir, base } = repo({
      'src/a.mjs': useless(3),
      'src/b.mjs': 'export const g = (a) => {\n  if (!a) return 1;\n  else return 2;\n};\n',
      [BASELINE]: baseline({
        [RULE]: 3,
        [OTHER]: 1,
        'eslint(no-else-return)': 1,
        'unicorn(no-negated-condition)': 1,
      }),
    });
    write(dir, { 'src/a.mjs': useless(1), 'src/b.mjs': 'export const g = (a) => (a ? 2 : 1);\n' });
    expect(ratchet(dir, base, '--write').status).toBe(0);
    expect(readBaseline(dir).rules).toEqual({ [RULE]: 1 });
    expect(ratchet(dir, base).status).toBe(0);
  });
});

describe('CQ-12 the baseline can only be lowered', () => {
  it('CQ-12 baseline only lowered: a baseline raised above the base branch fails, even with the code unchanged', () => {
    const { dir, base } = repo({ 'src/a.mjs': useless(2), [BASELINE]: baseline({ [RULE]: 2 }) });
    write(dir, { [BASELINE]: baseline({ [RULE]: 3 }) });
    const run = ratchet(dir, base);
    expect(run.status).toBe(1);
    expect(run.out).toContain(`${RULE}: 3 here, 2 on the base`);
  });

  it('CQ-12 baseline only lowered: a new rule added to the baseline fails against the base branch', () => {
    const { dir, base } = repo({ 'src/a.mjs': useless(1), [BASELINE]: baseline({ [RULE]: 1 }) });
    write(dir, { [BASELINE]: baseline({ [RULE]: 1, [OTHER]: 1 }) });
    const run = ratchet(dir, base);
    expect(run.status).toBe(1);
    expect(run.out).toContain(`${OTHER}: 1 here, 0 on the base`);
  });

  it('CQ-12 baseline only lowered: writing refuses a count that rose, and leaves the file as it was', () => {
    const { dir, base } = repo({ 'src/a.mjs': useless(1), [BASELINE]: baseline({ [RULE]: 1 }) });
    write(dir, { 'src/a.mjs': useless(2) });
    const run = ratchet(dir, base, '--write');
    expect(run.status).toBe(1);
    expect(run.out).toContain(`${RULE}: 2 here, 1 on the base`);
    expect(readBaseline(dir).rules).toEqual({ [RULE]: 1 });
  });

  it('CQ-12 baseline only lowered: the first baseline, on a base that has none, is written from the counts', () => {
    const { dir, base } = repo({ 'src/a.mjs': useless(2) });
    expect(ratchet(dir, base, '--write').status).toBe(0);
    expect(readBaseline(dir).rules).toEqual({ [RULE]: 2 });
    expect(ratchet(dir, base).status).toBe(0);
  });

  it('CQ-12 baseline only lowered: a base the script cannot read fails rather than skipping the comparison', () => {
    const { dir } = repo({ 'src/a.mjs': useless(1), [BASELINE]: baseline({ [RULE]: 1 }) });
    const run = ratchet(dir, '0000000000000000000000000000000000000000');
    expect(run.status).toBe(1);
    expect(run.out).toContain('cannot read the base');
  });
});

/** `n` lines of source with no warning but the 300-line one. */
const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `export const v${i} = ${i};\n`).join('');

describe('CQ-12 No product source file is over 1,000 lines on this head, and the ratchet holds that line', () => {
  it('CQ-12 over 1,000 lines: no tracked product source file on this head is over 1,000 lines', () => {
    const files = git(ROOT, 'ls-files', '--', 'apps', 'packages')
      .split('\n')
      .filter(
        (f) => /\.(?:[cm]?[jt]sx?)$/u.test(f) && !/(?:^|\/)tests\/|\.(?:test|spec)\./u.test(f),
      );
    expect(files.length).toBeGreaterThan(50);
    const over = files.filter(
      (f) => readFileSync(join(ROOT, f), 'utf8').trimEnd().split('\n').length > 1000,
    );
    expect(over).toEqual([]);
  });

  it('CQ-12 over 1,000 lines: a product source file of 1,001 lines fails, naming the file', () => {
    // Both files carry the pedantic 300-line warning; the baseline records the first.
    const { dir, base } = repo({
      'packages/p/src/ok.ts': lines(1000),
      [BASELINE]: baseline({ [MAX]: 1 }),
    });
    expect(ratchet(dir, base).status).toBe(0);

    write(dir, { 'apps/web/src/big.tsx': lines(1001) });
    const run = ratchet(dir, base);
    expect(run.status).toBe(1);
    expect(run.out).toContain('apps/web/src/big.tsx: 1001 lines');
  });

  it('CQ-12 over 1,000 lines: a test file of 1,001 lines is not product source and passes', () => {
    const { dir, base } = repo({
      'packages/p/tests/long.test.ts': lines(1001),
      'packages/p/src/long.spec.ts': lines(1001),
      [BASELINE]: baseline({ [MAX]: 2 }),
    });
    expect(ratchet(dir, base).status).toBe(0);
  });
});

it('Sol proof, criterion 4: a malformed baseline cannot hide a new warning', () => {
  const { dir, base } = repo({ 'src/a.mjs': useless(1), [BASELINE]: baseline({ [RULE]: 1 }) });
  write(dir, {
    'src/a.mjs': useless(2),
    [BASELINE]: JSON.stringify({ rules: { [RULE]: 'invalid' } }),
  });
  const run = ratchet(dir, base);
  expect(run.status).toBe(1);
  expect(run.out).toContain(RULE);
});

it('Sol proof, criterion 6: production CSS over 1,000 lines fails', () => {
  const { dir, base } = repo({ 'src/a.mjs': 'export const a = 1;\n', [BASELINE]: baseline({}) });
  const path = 'apps/web/src/styles/too-big.css';
  write(dir, { [path]: '.x { color: red; }\n'.repeat(1001) });
  const run = ratchet(dir, base);
  expect(run.status).toBe(1);
  expect(run.out).toContain(path);
});

it('Sol proof, criterion 6: trailing blank lines count toward the 1,000-line limit', () => {
  const { dir, base } = repo({
    'packages/p/src/ok.ts': lines(1000),
    [BASELINE]: baseline({ [MAX]: 1 }),
  });
  write(dir, { 'packages/p/src/ok.ts': `${lines(1000)}\n` });
  const run = ratchet(dir, base);
  expect(run.status).toBe(1);
  expect(run.out).toContain('packages/p/src/ok.ts: 1001 lines');
});
