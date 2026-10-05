// SPDX-License-Identifier: AGPL-3.0-only
// The pre-ready gate (scripts/pre-ready.mjs) admits only committed work on a
// branch of its own, and the checks it runs see none of the caller's tokens.

import { execFileSync, spawnSync } from 'node:child_process';
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

/** Sets `vars` for the length of `use`, as a caller's shell would. */
function withEnv<T>(vars: Record<string, string>, use: () => T): T {
  const before = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return use();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A test file that fails when it sees the caller's token or database address. */
const SEES_NO_CALLER_ENV = [
  "import { expect, it } from 'vitest';",
  '',
  "it('sees no token or database', () => {",
  "  expect(process.env['GH_TOKEN']).toBeUndefined();",
  "  expect(process.env['DATABASE_URL']).toBeUndefined();",
  '});',
  '',
].join('\n');

describe('the checks the gate runs see none of the caller’s tokens', () => {
  it(
    'keeps GH_TOKEN and CHECK_SCOPE from pnpm check',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'pre-ready-env-'));
      try {
        writeFileSync(
          join(dir, 'package.json'),
          JSON.stringify({
            name: 'gate-case',
            private: true,
            scripts: {
              check:
                'node -e "const e = process.env; process.exit(e.GH_TOKEN === undefined && e.CHECK_SCOPE === undefined ? 0 : 1)"',
            },
          }),
        );
        const result = withEnv({ GH_TOKEN: 'caller-token-marker', CHECK_SCOPE: 'light' }, () =>
          wholeCheck({ cwd: dir, skip: false }),
        );
        expect(result.ok, result.message).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SLOW,
  );

  it(
    'keeps GH_TOKEN and the database address from the test files it runs',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'pre-ready-env-'));
      try {
        symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
        mkdirSync(join(dir, 'tests', 'db'), { recursive: true });
        writeFileSync(join(dir, 'tests', 'db', 'named-suite-manifest.test.ts'), SEES_NO_CALLER_ENV);
        const result = withEnv(
          { GH_TOKEN: 'caller-token-marker', DATABASE_URL: 'postgres://caller.invalid/db' },
          () => suiteRegistration({ cwd: dir, tools: root }),
        );
        expect(result.ok, result.message).toBe(true);
      } finally {
        rmSync(join(dir, 'node_modules'), { force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SLOW,
  );
});

describe('the command line', () => {
  it('runs when called through a symlinked path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pre-ready-link-'));
    try {
      symlinkSync(root, join(dir, 'repo'));
      const result = spawnSync(
        process.execPath,
        [join(dir, 'repo', 'scripts', 'pre-ready.mjs'), '--not-a-flag'],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('unknown argument');
    } finally {
      rmSync(join(dir, 'repo'), { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
