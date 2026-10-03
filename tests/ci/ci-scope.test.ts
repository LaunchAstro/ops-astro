// SPDX-License-Identifier: AGPL-3.0-only
// Checks by scope (code-factory METHOD Phase 2 step 8): a pull request runs
// the checks its change touches, and the merge queue runs everything. Scoping
// is how a suite stops running quietly, so this proves: the queue and main
// always run everything; a change in each area runs exactly that area's named
// suites, and every area that imports or names a changed helper runs too; an
// unknown path or shared tooling runs everything; a shard with nothing in
// scope skips while every in-scope suite still lands in one shard; and the
// workflow keeps every required check's name.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { areaOf } from '../../scripts/ci-areas.ts';
import {
  changedFiles,
  checkRuns,
  dependentsOf,
  readScopeMap,
  scopeOf,
  shardInScope,
  suitesInScope,
  type ScopeMap,
} from '../../scripts/ci-scope.ts';
import { readNamedSuites } from '../../scripts/named-suites.ts';
import { dependenciesOf } from '../../scripts/import-closure.ts';

const root = new URL('../..', import.meta.url).pathname;
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const map = readScopeMap(join(root, 'scripts/ci-scope.json'));
const manifest = readNamedSuites(root);
const named = [...manifest.invariant, ...manifest.conformance];
const dependents = dependentsOf(root, named);
const scope = (event: string, changed: string[]) => scopeOf(event, changed, map, dependents);

const fixtureMap: ScopeMap = {
  scopable: ['tests/', 'apps/web/'],
  runsEverything: ['tests/support/'],
  visualDrift: ['apps/web/', 'tests/visual/'],
};
const fixtureDependents = (path: string): string[] =>
  path.startsWith('apps/web/')
    ? ['tests-web']
    : path.startsWith('tests/runtime/')
      ? ['tests-runtime']
      : [];
const fixtureScope = (changed: string[]) =>
  scopeOf('pull_request', changed, fixtureMap, fixtureDependents);

describe('the queue and main', () => {
  it('a merge group, a push to main or any other event runs everything, whatever changed', () => {
    for (const event of ['merge_group', 'push', 'workflow_dispatch', '']) {
      expect(scope(event, ['docs/README.md']).everything, event).toBe(true);
      expect(suitesInScope(scope(event, ['docs/README.md']), named)).toEqual(named);
    }
  });
});

describe('a pull request', () => {
  it('runs every named suite of the changed suite’s area, for every area outside runsEverything', () => {
    const areas = [...new Set(named.map((s) => areaOf(s)))];
    expect(areas.length).toBeGreaterThan(5);
    for (const area of areas) {
      const own = named.filter((s) => areaOf(s) === area);
      const first = (own[0] ?? '').split('#')[0] ?? '';
      const result = scope('pull_request', [first]);
      if (result.everything) {
        expect(
          map.runsEverything.some((p) => first.startsWith(p)),
          area,
        ).toBe(true);
        continue;
      }
      expect(result.areas, area).toContain(area);
      expect(suitesInScope(result, named), area).toEqual(expect.arrayContaining(own));
      for (const suite of suitesInScope(result, named)) {
        expect(result.areas).toContain(areaOf(suite));
      }
    }
  });
});

describe('a pull request reaching shared code', () => {
  it('runs every area whose suites import a changed helper, however deep', () => {
    const helper = 'tests/commands/fixture.ts';
    const users = named.filter((s) => dependenciesOf(root, s.split('#')[0] ?? s).includes(helper));
    const result = scope('pull_request', [helper]);
    expect(result.everything).toBe(false);
    expect(new Set(users.map((s) => areaOf(s))).size).toBeGreaterThan(3);
    for (const user of users) expect(result.everything || result.areas).toContain(areaOf(user));
  });

  it('runs the area of a suite that names a changed document or directory in a string', () => {
    expect(scope('pull_request', ['docs/agents/database-conformance.md'])).toMatchObject({
      everything: false,
    });
    const reader = named.find((s) =>
      dependenciesOf(root, s.split('#')[0] ?? s).some((d) => d.startsWith('docs/')),
    );
    expect(reader).toBeDefined();
    const doc = dependenciesOf(root, reader ?? '').find((d) => d.startsWith('docs/')) ?? '';
    const result = scope('pull_request', [doc]);
    expect(result.everything || result.areas).toContain(areaOf(reader ?? ''));
  });
});

describe('a pull request outside the scopable paths', () => {
  it('runs everything for a path the map does not name, shared tooling, or no changed file', () => {
    for (const changed of [
      ['README.md'],
      ['apps/api/server.ts'],
      ['migrations/0001_x.sql'],
      ['tests/db/named-suites.json'],
      ['a-new-top-level/thing.ts'],
      ['tests/support/fresh-database.ts'],
      ['pnpm-lock.yaml'],
      ['tests/runtime/x.test.ts', 'scripts/db-conformance.mjs'],
      [],
    ]) {
      expect(scope('pull_request', changed).everything, changed.join(',')).toBe(true);
    }
  });
});

describe('the heavy checks on a pull request', () => {
  it('runs only the areas that depend on a scopable path, and none for a path nothing reads', () => {
    expect(fixtureScope(['apps/web/src/main.tsx'])).toMatchObject({
      everything: false,
      areas: ['tests-web'],
    });
    expect(fixtureScope(['tests/visual/x.ts'])).toMatchObject({ everything: false, areas: [] });
  });

  it('runs database conformance and isolation only with a named suite in scope', () => {
    const suites = ['tests/web/a.test.ts', 'tests/runtime/b.test.ts'];
    const web = fixtureScope(['tests/visual/x.ts']);
    const runtime = fixtureScope(['tests/runtime/c.ts']);
    expect(checkRuns('database conformance', web, ['tests/visual/x.ts'], fixtureMap, suites)).toBe(
      false,
    );
    expect(checkRuns('isolation tests', web, ['tests/visual/x.ts'], fixtureMap, suites)).toBe(
      false,
    );
    expect(
      checkRuns('database conformance', runtime, ['tests/runtime/c.ts'], fixtureMap, suites),
    ).toBe(true);
    expect(checkRuns('isolation tests', runtime, ['tests/runtime/c.ts'], fixtureMap, suites)).toBe(
      true,
    );
  });

  it('runs visual drift only when a visual path changed, and always when everything runs', () => {
    const ran = (changed: string[]): boolean =>
      checkRuns('visual drift', fixtureScope(changed), changed, fixtureMap, []);
    expect(ran(['tests/visual/x.ts'])).toBe(true);
    expect(ran(['apps/web/src/a.tsx'])).toBe(true);
    expect(ran(['tests/runtime/c.ts'])).toBe(false);
    expect(ran(['tests/support/x.ts'])).toBe(true);
  });

  it('refuses a check it does not scope rather than skipping it', () => {
    const runtime = fixtureScope(['tests/runtime/c.ts']);
    expect(() => checkRuns('local checks', runtime, [], fixtureMap, [])).toThrow(/not scoped/u);
  });
});

describe('shards', () => {
  it('skips a shard with nothing in scope and puts every in-scope suite in exactly one shard', () => {
    const byArea = new Map<string, string[]>();
    for (const s of named) byArea.set(areaOf(s), [...(byArea.get(areaOf(s)) ?? []), s]);
    const scoped = [...byArea.values()].toSorted((a, b) => a.length - b.length)[0] ?? [];
    expect(scoped.length).toBeGreaterThan(0);
    const shards = Array.from({ length: 8 }, (_, i) =>
      shardInScope(scoped, root, { index: i + 1, count: 8 }),
    );
    expect(shards.some((s) => s.length === 0)).toBe(true);
    const items = shards.flat().map((item) => item.split('#')[0]);
    expect(items.toSorted()).toEqual([...new Set(items)].toSorted());
    expect(new Set(items)).toEqual(new Set(scoped));
  });
});

describe('changed files', () => {
  it('counts a rename as both its old and new path, and a deletion', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ci-scope-'));
    try {
      const git = (...args: string[]): string =>
        execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', ...args], {
          encoding: 'utf8',
        });
      git('init', '-q', '-b', 'main');
      mkdirSync(join(repo, 'tests/runtime'), { recursive: true });
      writeFileSync(join(repo, 'tests/runtime/a.test.ts'), 'export {};\n'.repeat(20));
      writeFileSync(join(repo, 'gone.ts'), 'x\n');
      git('add', '.');
      git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD').trim();
      mkdirSync(join(repo, 'apps/web'), { recursive: true });
      git('mv', 'tests/runtime/a.test.ts', 'apps/web/a.ts');
      git('rm', '-q', 'gone.ts');
      git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'move');
      expect(changedFiles(base, repo).toSorted()).toEqual(
        ['apps/web/a.ts', 'gone.ts', 'tests/runtime/a.test.ts'].toSorted(),
      );
      expect(() => changedFiles('0000000000000000000000000000000000000000', repo)).toThrow();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('the wrapper as a process', () => {
  it('runs the command on a merge group and passes its exit code, called by any path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-scope-link-'));
    try {
      const link = join(dir, 'ci-scope.ts');
      symlinkSync(join(root, 'scripts/ci-scope.ts'), link);
      for (const script of [join(root, 'scripts/ci-scope.ts'), link]) {
        const run = spawnSync(
          process.execPath,
          [script, 'isolation tests', '--', 'sh', '-c', 'exit 7'],
          {
            cwd: root,
            env: { ...process.env, GITHUB_EVENT_NAME: 'merge_group' },
            encoding: 'utf8',
          },
        );
        expect(run.status, script).toBe(7);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('every isolation suite is a named suite, so its area is read like theirs', () => {
    const isolation = JSON.parse(read('tests/db/isolation-suites.json')) as Record<string, unknown>;
    const lists = Object.entries(isolation).filter(([key]) => key !== 'comment');
    expect(lists.map(([key]) => key)).toEqual(['invariant']);
    const all = new Set(named);
    for (const [, list] of lists) {
      expect((list as string[]).filter((s) => !all.has(s))).toEqual([]);
    }
  });
});

describe('the kept map against the code', () => {
  it('visual drift’s entry files and the built app depend only on visual or run-everything paths', () => {
    const entries = [
      'tests/visual/app-drift-cases.ts',
      'tests/visual/run.ts',
      'tests/visual/look.ts',
      'apps/web/src/main.tsx',
      'apps/web/vite.config.ts',
    ];
    const outside = entries
      .flatMap((entry) => [entry].concat(dependenciesOf(root, entry)))
      .filter((dep) => !map.visualDrift.some((p) => `${dep}/`.startsWith(p) || dep.startsWith(p)))
      .filter((dep) => !scope('pull_request', [dep]).everything);
    expect([...new Set(outside)]).toEqual([]);
  });
});

describe('the workflow', () => {
  const ci = read('.github/workflows/ci.yml');
  const job = (key: string): string => {
    const start = ci.indexOf(`\n  ${key}:\n`);
    const next = ci.slice(start + 1).search(/\n {2}[\w-]+:\n/u);
    return ci.slice(start + 1, next === -1 ? undefined : start + 1 + next + 1);
  };

  it('keeps every required check this workflow reports, by name', () => {
    const required = (
      JSON.parse(read('.github/required-checks.json')) as {
        required_status_checks: { context: string; integration_id: number }[];
      }
    ).required_status_checks.filter((c) => c.integration_id === 15368);
    const reported = [
      ...ci.matchAll(/^ {4}name: (.+)$/gmu),
      ...read('.github/workflows/review-evidence.yml').matchAll(/^ {4}name: (.+)$/gmu),
    ].map((m) => m[1]);
    for (const { context } of required) expect(reported, context).toContain(context);
  });

  it('scopes only the three heavy checks, each deciding in its own step with no job-level skip', () => {
    for (const key of ['database-shard', 'isolation', 'visual-drift']) {
      const block = job(key);
      expect(block, key).toMatch(/node scripts\/ci-scope\.ts/u);
      expect(block, key).not.toMatch(/^ {4}if:/mu);
      expect(block, key).not.toMatch(/needs: \[[^\]]*scope/u);
    }
    const others = ci
      .split(/\n(?= {2}[\w-]+:\n)/u)
      .filter((b) => !/^ {2}(database-shard|isolation|visual-drift):/u.test(b));
    for (const block of others) expect(block).not.toMatch(/ci-scope/u);
  });
});
