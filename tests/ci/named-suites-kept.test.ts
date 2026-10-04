// SPDX-License-Identifier: AGPL-3.0-only
//
// ORCH91 MAGNETS step 1: deleting a suite's own file drops it with no list diff, so `database
// conformance gate` runs `node scripts/named-suites.ts kept <base>`. It reads the base's manifest in
// any layout it has had and fails on each suite the base named or marked isolation that the head
// does not: a deleted test file takes its suite with it, a renamed one takes it to the new path.
// The script cases run the real script in a throwaway git repository; the wiring case reads ci.yml.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts/named-suites.ts');
const dir = mkdtempSync(join(tmpdir(), 'named-suites-kept-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Git without the machine's own settings (signing, hooks, URL rewrites).
const GIT_ENV = {
  PATH: process.env['PATH'],
  HOME: dir,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** Files by path: a string is written as is, anything else as JSON; null removes the file. */
type Files = Record<string, unknown>;

function write(repo: string, files: Files): void {
  for (const [path, body] of Object.entries(files)) {
    const file = join(repo, path);
    rmSync(file, { recursive: true, force: true });
    if (body === null) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  }
}

const commit = (repo: string, message: string): string => {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
};

/** A new repository whose first commit, the base, holds `files`. */
function repoWith(files: Files): { repo: string; base: string } {
  const repo = mkdtempSync(join(dir, 'repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, files);
  return { repo, base: commit(repo, 'base') };
}

/** Commits `files` over the base as the head. */
const head = (repo: string, files: Files): string => {
  write(repo, files);
  return commit(repo, 'head');
};

/** Runs the check as the gate does, in `repo`, on `event`. */
function kept(repo: string, base?: string, event = 'pull_request') {
  const args = base === undefined ? [SCRIPT, 'kept'] : [SCRIPT, 'kept', base];
  const run = spawnSync(process.execPath, args, {
    cwd: repo,
    env: { ...GIT_ENV, GITHUB_EVENT_NAME: event },
    encoding: 'utf8',
  });
  return { status: run.status, out: run.stdout + run.stderr };
}

const A = 'tests/api/a.test.ts';
const B = 'tests/api/b.test.ts';
const C = 'tests/api/c.test.ts';
const suite = (kind: string, isolation: boolean) => ({ kind, isolation, why: 'w' });
const fileOf = (path: string) => `tests/db/suites/${path.slice('tests/'.length)}.json`;
const TESTS: Files = { [A]: 'test a', [B]: 'test b', [C]: 'test c' };

/** A named invariant and isolation, B named conformance, each in a file of its own. */
const PER_SUITE: Files = {
  ...TESTS,
  [fileOf(A)]: suite('invariant', true),
  [fileOf(B)]: suite('conformance', false),
};
/** The same suites in the per-area folder and the isolation list. */
const PER_AREA: Files = {
  ...TESTS,
  'tests/db/named-suites/_history.json': { comment: ['why the suites are named'] },
  'tests/db/named-suites/tests-api.json': { invariant: [A], conformance: [B] },
  'tests/db/isolation-suites.json': { invariant: [A] },
};
/** The same suites in the single file and the isolation list. */
const SINGLE: Files = {
  ...TESTS,
  'tests/db/named-suites.json': { comment: [], invariant: [A], conformance: [B] },
  'tests/db/isolation-suites.json': { invariant: [A] },
};
/** The head's switch from an older layout to one file per suite. */
const TO_PER_SUITE: Files = {
  'tests/db/named-suites': null,
  'tests/db/named-suites.json': null,
  'tests/db/isolation-suites.json': null,
  [fileOf(A)]: suite('invariant', true),
  [fileOf(B)]: suite('conformance', false),
};

describe('a suite named at the base stays named at the head', () => {
  it('passes a head that names every suite the base named, printing the counts', () => {
    const { repo, base } = repoWith(PER_SUITE);
    head(repo, { [fileOf(C)]: suite('conformance', false) });
    const run = kept(repo, base);
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('named 2 -> 3, isolation 1 -> 1');
  });

  it('fails naming every suite the head stopped naming while its test file stays', () => {
    const { repo, base } = repoWith(PER_SUITE);
    head(repo, { [fileOf(A)]: null, [fileOf(B)]: null });
    const run = kept(repo, base);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain(A);
    expect(run.out).toContain(B);
  });

  it('fails when a suite marked isolation at the base is unmarked at the same path', () => {
    const { repo, base } = repoWith(PER_SUITE);
    head(repo, { [fileOf(A)]: suite('invariant', false) });
    const run = kept(repo, base);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toMatch(/isolation/u);
    expect(run.out).toContain(A);
    expect(run.out).not.toContain(B);
  });

  it('passes a suite whose test file was deleted with it', () => {
    const { repo, base } = repoWith(PER_SUITE);
    head(repo, { [fileOf(B)]: null, [B]: null });
    const run = kept(repo, base);
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('named 2 -> 1, isolation 1 -> 1');
  });
});

describe('a renamed test file keeps its suite at the new path', () => {
  const MOVED = 'tests/api/moved.test.ts';
  /** Renames A's test file to `to` in the head, removing A's suite file and writing `named`. */
  function renamed(to: string, named: Files) {
    const { repo, base } = repoWith(PER_SUITE);
    git(repo, 'mv', A, to);
    head(repo, { [fileOf(A)]: null, ...named });
    return kept(repo, base);
  }

  it('passes a rename that takes the suite, its kind and its isolation to the new path', () => {
    const run = renamed(MOVED, { [fileOf(MOVED)]: suite('invariant', true) });
    expect(run.status, run.out).toBe(0);
  });

  it.each([
    ['is not named', MOVED, {}],
    ['differs only in case and is not named', 'tests/api/A.test.ts', {}],
    ['is not marked isolation', MOVED, { [fileOf(MOVED)]: suite('invariant', false) }],
    ['is named as another kind', MOVED, { [fileOf(MOVED)]: suite('conformance', true) }],
  ])('fails when the new path %s, naming the old path and the new', (_, to, named: Files) => {
    const run = renamed(to, named);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain(`${A} -> ${to}`);
  });
});

describe('the base, in every layout it has had and wherever it is', () => {
  it.each([
    ['per-area', PER_AREA],
    ['single-file', SINGLE],
  ])('reads a base in the %s layout with its isolation list', (_, layout: Files) => {
    const same = repoWith(layout);
    head(same.repo, TO_PER_SUITE);
    const run = kept(same.repo, same.base);
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('named 2 -> 2, isolation 1 -> 1');
    for (const [path, body] of Object.entries({ [B]: null, [A]: suite('invariant', false) })) {
      const dropped = repoWith(layout);
      head(dropped.repo, { ...TO_PER_SUITE, [fileOf(path)]: body });
      const lost = kept(dropped.repo, dropped.base);
      expect(lost.status, lost.out).toBe(1);
      expect(lost.out).toContain(path);
    }
  });

  it('fetches a base the depth-1 checkout does not hold', () => {
    const { repo, base } = repoWith(PER_SUITE);
    head(repo, { [fileOf(C)]: suite('conformance', false) });
    const remote = join(mkdtempSync(join(dir, 'remote-')), 'remote.git');
    git(dir, 'init', '-q', '--bare', remote);
    git(repo, 'push', '-q', remote, 'main');
    const shallow = join(mkdtempSync(join(dir, 'shallow-')), 'work');
    git(dir, 'clone', '-q', '--depth', '1', '--branch', 'main', `file://${remote}`, shallow);
    expect(
      spawnSync('git', ['cat-file', '-e', base], { cwd: shallow, env: GIT_ENV }).status,
    ).not.toBe(0);
    const run = kept(shallow, base);
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('named 2 -> 3, isolation 1 -> 1');
  });
});

describe('the check fails closed', () => {
  it('refuses a base that is not a full commit id', () => {
    const { repo, base } = repoWith(PER_SUITE);
    for (const bad of [
      '',
      base.slice(0, 7),
      'HEAD',
      '--output=/dev/null',
      'g'.repeat(40),
      `${base}a`,
      `${base}\n`,
    ]) {
      const run = kept(repo, bad);
      expect(run.status, JSON.stringify(bad)).toBe(1);
      expect(run.out).toMatch(/40 or 64 hex/u);
    }
    expect(kept(repo).status).toBe(1);
  });

  it('refuses an all-zero base on every event, and says why on a push', () => {
    const { repo } = repoWith(PER_SUITE);
    for (const event of ['pull_request', 'merge_group', 'push']) {
      const run = kept(repo, '0'.repeat(40), event);
      expect(run.status, event).toBe(1);
      expect(run.out).toMatch(/no base commit/u);
    }
    expect(kept(repo, '0'.repeat(40), 'push').out).toMatch(/push to main/u);
  });

  it('fails when git can neither find nor fetch the base', () => {
    const { repo } = repoWith(PER_SUITE);
    const run = kept(repo, 'f'.repeat(40));
    expect(run.status, run.out).toBe(1);
    expect(run.out).toMatch(/could not fetch/u);
  });

  it('fails on a base whose manifest it cannot read, naming the file', () => {
    const broken = repoWith({ ...PER_SUITE, [fileOf(A)]: '{not json' });
    head(broken.repo, { [fileOf(A)]: suite('invariant', true) });
    const run = kept(broken.repo, broken.base);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain(fileOf(A));
    expect(run.out).toMatch(/at the base/u);
    const none = repoWith(TESTS);
    head(none.repo, PER_SUITE);
    const empty = kept(none.repo, none.base);
    expect(empty.status, empty.out).toBe(1);
    expect(empty.out).toMatch(/at the base/u);
  });
});

type Step = Record<string, unknown>;
const NAME = 'No named or isolation suite is dropped';
// On a pull request or a group, merge-group.mjs runs the check once per pull request it judges,
// each against its own base; on a push there is no pull request, so the base is the push's
// `before`. A shell branch, not a step condition: a step condition could skip a group.
const RUN = [
  'if [ "$GITHUB_EVENT_NAME" = push ]; then',
  '  node scripts/named-suites.ts kept "$BEFORE"',
  'else',
  `  node scripts/merge-group.mjs each sh -c 'node scripts/named-suites.ts kept "$BASE_SHA"'`,
  'fi',
  '',
].join('\n');

describe('the wiring', () => {
  it('runs in the database conformance gate on every event, once per pull request on a pull request or a group, the push base through env', () => {
    const text = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const ci = parse(text) as {
      on: Record<string, unknown>;
      jobs: Record<string, { name?: string; if?: unknown; steps?: Step[] }>;
    };
    expect(Object.keys(ci.on).toSorted()).toStrictEqual(['merge_group', 'pull_request', 'push']);
    const job = ci.jobs['database-gate'];
    expect(job?.name).toBe('database conformance gate');
    expect(job).not.toHaveProperty('if');
    const steps = job?.steps ?? [];
    // merge-group.mjs walks a group's first parents from its head down to the base tip, which a
    // depth-1 checkout does not hold.
    const checkout = steps.find((s) => String(s['uses']).startsWith('actions/checkout@'));
    expect(checkout?.['with']).toStrictEqual({ 'fetch-depth': 0 });
    const at = steps.findIndex((s) => s['name'] === NAME);
    expect(at).toBeGreaterThan(-1);
    const step = steps[at] ?? {};
    expect(step['run']).toBe(RUN);
    expect(step).not.toHaveProperty('if');
    expect(step).not.toHaveProperty('continue-on-error');
    // The event's values reach the step through env alone; the script validates, then calls git.
    expect(step['env']).toStrictEqual({ BEFORE: '${{ github.event.before }}' });
    for (const s of steps) expect(String(s['run'] ?? '')).not.toContain('${{');
    expect(
      steps.filter((s) => String(s['run'] ?? '').includes('named-suites.ts kept')),
    ).toHaveLength(1);
    const node = steps.findIndex((s) => String(s['uses']).startsWith('actions/setup-node@'));
    expect(node).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(node);
  });
});
