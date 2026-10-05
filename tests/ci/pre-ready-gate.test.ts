// SPDX-License-Identifier: AGPL-3.0-only
// The pre-ready gate (scripts/pre-ready.mjs): each step goes red on the case
// it exists for and green on a clean one, and the gate stops at the first red.
//
// These steps read only git, or nothing, so they run in a small throwaway
// repository. The steps that run main's checks over a tree are in
// pre-ready-gate-tree.test.ts.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- the gate is a plain JavaScript module, as lanes run it
import * as gate from '../../scripts/pre-ready-steps.mjs';

const { commitTrailers, mergeTree, reviewEvidence, runGate, wholeCheck } = gate;
const root = join(import.meta.dirname, '../..');
const SLOW = 120_000;

const TRAILERS = 'Assisted-by: LLM\nAgent-model: claude-opus-5-5\nAgent-tool: Claude Code';

const gitIn =
  (dir: string) =>
  (...args: string[]): string =>
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

/** A throwaway repository with one seed commit on `main`. */
function smallRepo(): { dir: string; git: (...args: string[]) => string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pre-ready-small-'));
  const git = gitIn(dir);
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', `chore: seed\n\n${TRAILERS}`);
  return { dir, git, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('the gate runs its steps in order', () => {
  it('stops at the first red step and names it', () => {
    const ran: string[] = [];
    const lines: string[] = [];
    const step = (id: string, ok: boolean) => ({
      id,
      name: `step ${id}`,
      run: () => {
        ran.push(id);
        return { ok, message: ok ? 'fine' : 'planted red' };
      },
    });
    const result = runGate([step('a', true), step('b', false), step('c', true)], (line: string) =>
      lines.push(line),
    );
    expect(result.ok).toBe(false);
    expect(result.failed).toBe('b');
    expect(ran).toEqual(['a', 'b']);
    expect(lines.join('\n')).toContain('(b) step b: red');
    expect(lines.join('\n')).toContain('planted red');
  });
});

describe('(a) the whole check', () => {
  it('says plainly that it skipped the check when the caller ran it elsewhere', () => {
    const result = wholeCheck({ cwd: root, skip: true });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('skipped');
    expect(result.message).toContain('did not run pnpm check');
  });

  it(
    'is red when pnpm check fails and green when it passes',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'pre-ready-check-'));
      try {
        const write = (code: number) =>
          writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify({
              name: 'gate-case',
              private: true,
              scripts: { check: `node -e "process.exit(${code})"` },
            }),
          );
        write(1);
        expect(wholeCheck({ cwd: dir, skip: false }).ok).toBe(false);
        write(0);
        expect(wholeCheck({ cwd: dir, skip: false }).ok).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SLOW,
  );
});

describe('(d) commit trailers', () => {
  it(
    'is red for a merge commit without trailers and green once it carries them',
    () => {
      const repo = smallRepo();
      try {
        const { git } = repo;
        const base = git('rev-parse', 'HEAD');
        git('checkout', '-q', '-b', 'side');
        writeFileSync(join(repo.dir, 'b.txt'), 'side\n');
        git('add', '-A');
        git('commit', '-q', '--no-verify', '-m', `test: add b\n\n${TRAILERS}`);
        git('checkout', '-q', '-b', 'work', base);
        writeFileSync(join(repo.dir, 'c.txt'), 'work\n');
        git('add', '-A');
        git('commit', '-q', '--no-verify', '-m', `test: add c\n\n${TRAILERS}`);
        const own = git('rev-parse', 'HEAD');

        git('merge', '-q', '--no-ff', '--no-verify', '-m', 'chore: merge side into work', 'side');
        const bare = git('rev-parse', 'HEAD');
        const red = commitTrailers({ cwd: repo.dir, tools: root, base, head: bare });
        expect(red.ok).toBe(false);
        expect(red.message).toContain(bare.slice(0, 9));

        git('reset', '-q', '--hard', own);
        git(
          'merge',
          '-q',
          '--no-ff',
          '--no-verify',
          '-m',
          'chore: merge side into work',
          '-m',
          TRAILERS,
          'side',
        );
        const signed = git('rev-parse', 'HEAD');
        const green = commitTrailers({ cwd: repo.dir, tools: root, base, head: signed });
        expect(green.ok, green.message).toBe(true);
      } finally {
        repo.done();
      }
    },
    SLOW,
  );
});

describe('(e) review evidence on the pull request body', () => {
  const HEAD = '1111111111111111111111111111111111111111';
  const block = [
    'Reviewer: Codex',
    'Model: gpt-6-sol',
    `Head SHA: ${HEAD}`,
    'Verdict: approve',
    '',
    'Review checkpoint',
    '  branch:      work',
    '  base:        main',
    `  head:        ${HEAD}`,
    '  commits:     1',
    '',
    'Code review: no findings',
    '',
    'Security review: not required: no sensitive paths changed',
  ].join('\n');
  const common = {
    cwd: root,
    tools: root,
    freshRef: 'HEAD',
    head: HEAD,
    labels: '',
    changedFiles: 'README.md',
    agentModels: 'claude-opus-5-5',
  };

  it('is red for a body without review evidence', () => {
    const result = reviewEvidence({ ...common, body: 'Built and tested. Ready.' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('review evidence');
  });

  it('is green for a body whose evidence is bound to the head', () => {
    const result = reviewEvidence({ ...common, body: block });
    expect(result.ok, result.message).toBe(true);
  });

  it('is red, naming the ref, when the checker cannot be read from it', () => {
    const result = reviewEvidence({ ...common, freshRef: 'refs/heads/no-such-ref', body: block });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('refs/heads/no-such-ref');
  });
});

describe('(g) merge-tree against main', () => {
  it('is red and names the file when the branch conflicts with main', () => {
    const repo = smallRepo();
    try {
      const { git } = repo;
      git('checkout', '-q', '-b', 'work');
      writeFileSync(join(repo.dir, 'a.txt'), 'three\n');
      git('commit', '-q', '--no-verify', '-am', `test: change a\n\n${TRAILERS}`);
      const head = git('rev-parse', 'HEAD');
      git('checkout', '-q', 'main');
      writeFileSync(join(repo.dir, 'a.txt'), 'two\n');
      git('commit', '-q', '--no-verify', '-am', `test: change a on main\n\n${TRAILERS}`);
      const main = git('rev-parse', 'HEAD');

      const result = mergeTree({ cwd: repo.dir, base: main, head });
      expect(result.ok).toBe(false);
      expect(result.message).toContain('a.txt');
    } finally {
      repo.done();
    }
  });

  it('is green when the branch and main change different files', () => {
    const repo = smallRepo();
    try {
      const { git } = repo;
      git('checkout', '-q', '-b', 'work');
      writeFileSync(join(repo.dir, 'b.txt'), 'work\n');
      git('add', '-A');
      git('commit', '-q', '--no-verify', '-m', `test: add b\n\n${TRAILERS}`);
      const head = git('rev-parse', 'HEAD');
      git('checkout', '-q', 'main');
      writeFileSync(join(repo.dir, 'a.txt'), 'two\n');
      git('commit', '-q', '--no-verify', '-am', `test: change a on main\n\n${TRAILERS}`);
      const main = git('rev-parse', 'HEAD');

      const result = mergeTree({ cwd: repo.dir, base: main, head });
      expect(result.ok, result.message).toBe(true);
    } finally {
      repo.done();
    }
  });
});
