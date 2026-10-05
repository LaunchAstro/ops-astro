// SPDX-License-Identifier: AGPL-3.0-only
// The pre-ready gate (scripts/pre-ready.mjs) admits only committed work on a
// branch of its own, and the checks it runs see none of the caller's tokens.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- the gate is a plain JavaScript module, as lanes run it
import * as gate from '../../scripts/pre-ready-steps.mjs';

const { preflight, suiteRegistration, wholeCheck } = gate;
const root = join(import.meta.dirname, '../..');
const SLOW = 120_000;

const TRAILERS = 'Assisted-by: LLM\nAgent-model: claude-opus-5-5\nAgent-tool: Claude Code';

/** A throwaway repository with one seed commit on `main`. */
function smallRepo(): { dir: string; git: (...args: string[]) => string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pre-ready-admission-'));
  const git = (...args: string[]): string =>
    execFileSync(
      'git',
      [
        '-C',
        dir,
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
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', `chore: seed\n\n${TRAILERS}`);
  return { dir, git, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('admission', () => {
  it('refuses work committed on main itself, though the tree is clean', () => {
    const repo = smallRepo();
    try {
      const base = repo.git('rev-parse', 'HEAD');
      writeFileSync(join(repo.dir, 'a.txt'), 'two\n');
      repo.git('commit', '-q', '--no-verify', '-am', `test: work on main\n\n${TRAILERS}`);
      const result = preflight({ cwd: repo.dir, tools: root, base });
      expect(result.ok, result.message).toBe(false);
      expect(result.message).toContain('main');
    } finally {
      repo.done();
    }
  });

  it('admits the same work on its own branch', () => {
    const repo = smallRepo();
    try {
      const base = repo.git('rev-parse', 'HEAD');
      repo.git('checkout', '-q', '-b', 'work');
      writeFileSync(join(repo.dir, 'a.txt'), 'two\n');
      repo.git('commit', '-q', '--no-verify', '-am', `test: work on a branch\n\n${TRAILERS}`);
      const result = preflight({ cwd: repo.dir, tools: root, base });
      expect(result.ok, result.message).toBe(true);
    } finally {
      repo.done();
    }
  });
});

/** Sets GH_TOKEN for the length of `use`, as a caller's shell would. */
function withToken<T>(use: () => T): T {
  const before = process.env['GH_TOKEN'];
  process.env['GH_TOKEN'] = 'caller-token-marker';
  try {
    return use();
  } finally {
    if (before === undefined) delete process.env['GH_TOKEN'];
    else process.env['GH_TOKEN'] = before;
  }
}

describe('the checks the gate runs see none of the caller’s tokens', () => {
  it(
    'keeps GH_TOKEN from pnpm check',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'pre-ready-env-'));
      try {
        writeFileSync(
          join(dir, 'package.json'),
          JSON.stringify({
            name: 'gate-case',
            private: true,
            scripts: {
              check: 'node -e "process.exit(process.env.GH_TOKEN === undefined ? 0 : 1)"',
            },
          }),
        );
        const result = withToken(() => wholeCheck({ cwd: dir, skip: false }));
        expect(result.ok, result.message).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SLOW,
  );

  it(
    'keeps GH_TOKEN from the test files it runs',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'pre-ready-env-'));
      try {
        symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
        mkdirSync(join(dir, 'tests', 'db'), { recursive: true });
        writeFileSync(
          join(dir, 'tests', 'db', 'named-suite-manifest.test.ts'),
          "import { expect, it } from 'vitest';\n\nit('sees no token', () => {\n  expect(process.env['GH_TOKEN']).toBeUndefined();\n});\n",
        );
        const result = withToken(() => suiteRegistration({ cwd: dir, tools: root }));
        expect(result.ok, result.message).toBe(true);
      } finally {
        rmSync(join(dir, 'node_modules'), { force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SLOW,
  );
});
