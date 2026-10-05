// SPDX-License-Identifier: AGPL-3.0-only
// The pre-ready gate's steps that run main's own checks over a tree: changed-
// file lint, named-suite registration and behaviour test names. Each runs in
// a detached worktree of this repository's HEAD, with one planted commit per
// case; the git-only steps are in pre-ready-gate.test.ts.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
// @ts-expect-error -- the gate is a plain JavaScript module, as lanes run it
import * as gate from '../../scripts/pre-ready-steps.mjs';

const { behaviourNames, changedLint, suiteRegistration } = gate;
const root = join(import.meta.dirname, '../..');
const SLOW = 120_000;
const TRAILERS = 'Assisted-by: LLM\nAgent-model: claude-opus-5-5\nAgent-tool: Claude Code';

let tree = '';
let base = '';
const commits: Record<string, string> = {};
const git = (...args: string[]): string =>
  execFileSync(
    'git',
    [
      '-C',
      tree,
      '-c',
      'user.name=Gate Case',
      '-c',
      'user.email=gate-case@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { encoding: 'utf8' },
  ).trim();

/** One commit on top of the base, holding `files`; returns its sha. */
const plant = (files: Record<string, string>): string => {
  git('checkout', '-q', '--detach', base);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(tree, path)), { recursive: true });
    writeFileSync(join(tree, path), text);
  }
  git('add', '-A', '--', ...Object.keys(files));
  git('commit', '-q', '--no-verify', '-m', `test: planted case\n\n${TRAILERS}`);
  return git('rev-parse', 'HEAD');
};
const at = (name: string) => {
  git('checkout', '-q', '--detach', commits[name] ?? '');
  return { cwd: tree, tools: tree, base, head: commits[name] ?? '' };
};

beforeAll(() => {
  tree = mkdtempSync(join(tmpdir(), 'pre-ready-tree-'));
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', tree, 'HEAD']);
  symlinkSync(join(root, 'node_modules'), join(tree, 'node_modules'));
  base = git('rev-parse', 'HEAD');
  commits['clean'] = plant({
    'tests/ci/planted-clean.test.ts':
      "import { expect, it } from 'vitest';\n\nit('adds up', () => {\n  expect(1 + 1).toBe(2);\n});\n",
  });
  commits['unformatted'] = plant({
    'tests/ci/planted-unformatted.test.ts':
      "import { expect, it } from 'vitest'\nit('adds up',()=>{expect(1+1).toBe(2)})\n",
  });
  commits['unnamed'] = plant({
    'tests/reads/planted-database.test.ts':
      "import { expect, it } from 'vitest';\nimport '../support/fresh-database.ts';\n\nit('adds up', () => {\n  expect(1 + 1).toBe(2);\n});\n",
  });
  const title = ['So', 'l proof: a planted title'].join('');
  commits['reviewTitle'] = plant({
    'tests/ci/planted-title.test.ts': `import { expect, it } from 'vitest';\n\nit('${title}', () => {\n  expect(1 + 1).toBe(2);\n});\n`,
  });
}, SLOW);

afterAll(() => {
  if (tree === '') return;
  unlinkSync(join(tree, 'node_modules'));
  execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', tree]);
});

it(
  '(b) changed-file lint is red for an unformatted file and green for a clean one',
  () => {
    const red = changedLint(at('unformatted'));
    expect(red.ok).toBe(false);
    expect(red.message).toContain('planted-unformatted.test.ts');
    const green = changedLint(at('clean'));
    expect(green.ok, green.message).toBe(true);
  },
  SLOW,
);

it(
  '(c) suite registration is red for an unnamed database suite and green for a pure one',
  () => {
    const red = suiteRegistration(at('unnamed'));
    expect(red.ok).toBe(false);
    expect(red.message).toContain('planted-database.test.ts');
    const green = suiteRegistration(at('clean'));
    expect(green.ok, green.message).toBe(true);
  },
  SLOW,
);

it(
  '(f) behaviour test names are red for a title citing a reviewer and green otherwise',
  () => {
    const red = behaviourNames(at('reviewTitle'));
    expect(red.ok).toBe(false);
    expect(red.message).toContain('planted-title.test.ts');
    const green = behaviourNames(at('clean'));
    expect(green.ok, green.message).toBe(true);
  },
  SLOW,
);
