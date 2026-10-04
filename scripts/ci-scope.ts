// SPDX-License-Identifier: AGPL-3.0-only
// Checks by scope: which of the heavy checks a pull request runs, and which
// named suites (code-factory METHOD Phase 2 step 8, "Where the full tests
// run"). The merge queue and main run everything; this narrows only a pull
// request, so the gate before main is the full suite on the combined head.
//
// The areas a change touches come from the code, not from a hand list: for
// each changed path, every named suite that reaches it through imports or
// names it in a string (scripts/import-closure.ts) puts its area in scope,
// and every named suite in those areas runs. scripts/ci-scope.json is the
// kept part: `scopable` prefixes may be narrowed this way, `runsEverything`
// prefixes never are, and any path outside `scopable` runs everything.
// `visualDrift` lists what the visual drift job builds and reads.

// A scoped job wraps each heavy step in this, so no step carries a condition
// that could skip a merge group (tests/ci/merge-group-workflows.test.ts): the
// job always runs and reports its required name, the wrapped command runs or
// the step says why not, and on a group or a push it always runs. A selector
// that fails fails the step.
//
// Usage: node scripts/ci-scope.ts <check> [--shard i/n] -- <command> [args...]
//        node scripts/ci-scope.ts <check> --decide   (prints run or skip)
//   GITHUB_EVENT_NAME  the event; anything but pull_request runs everything.
//   On a pull request the base is `node scripts/merge-group.mjs base`.
//   A scoped database shard gets `--manifest <in-scope suites>` appended.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { areaOf } from './ci-areas.ts';
import { dependenciesOf } from './import-closure.ts';
import { assignShards, parseShard, planItems, readPlan, type Part } from './db-shards.ts';
import { readNamedSuites } from './named-suites.ts';

export interface ScopeMap {
  readonly scopable: readonly string[];
  readonly runsEverything: readonly string[];
  readonly visualDrift: readonly string[];
}

/** The areas of the named suites that depend on a path. */
export type Dependents = (path: string) => readonly string[];

export type Scope =
  | { readonly everything: true; readonly reasons: readonly string[] }
  | { readonly everything: false; readonly areas: readonly string[]; readonly reasons: string[] };

const SCOPED = ['database conformance', 'isolation tests', 'visual drift'] as const;

const isPrefixList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((p) => typeof p === 'string' && p !== '');

/** The kept map, refusing anything malformed rather than reading it as empty. */
export const readScopeMap = (path: string): ScopeMap => {
  const map = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  for (const key of ['scopable', 'runsEverything', 'visualDrift']) {
    if (!isPrefixList(map[key])) throw new Error(`${path}: ${key} must be a list of paths`);
  }
  return map as unknown as ScopeMap;
};

/**
 * Which areas depend on a path, from every named suite's import closure. A suite
 * depends on itself, on each file it reaches and on each path it names; a named
 * directory covers every path under it.
 */
export const dependentsOf = (root: string, suites: readonly string[]): Dependents => {
  const files = new Map<string, Set<string>>();
  const directories: [string, string][] = [];
  for (const suite of new Set(suites.map((s) => s.split('#')[0] ?? s))) {
    const area = areaOf(suite);
    for (const dep of [suite, ...dependenciesOf(root, suite)]) {
      if (existsSync(join(root, dep)) && statSync(join(root, dep)).isDirectory()) {
        directories.push([`${dep.replace(/\/+$/u, '')}/`, area]);
      } else {
        files.set(dep, (files.get(dep) ?? new Set()).add(area));
      }
    }
  }
  return (path) => [
    ...new Set([
      ...(files.get(path) ?? []),
      ...directories.filter(([dir]) => path.startsWith(dir)).map(([, area]) => area),
    ]),
  ];
};

export const scopeOf = (
  event: string,
  changed: readonly string[],
  map: ScopeMap,
  dependents: Dependents,
): Scope => {
  if (event !== 'pull_request') {
    return { everything: true, reasons: [`${event || 'no event'}: everything runs`] };
  }
  if (changed.length === 0) {
    return { everything: true, reasons: ['no changed file read: everything runs'] };
  }
  const areas = new Set<string>();
  const reasons: string[] = [];
  for (const path of changed) {
    if (
      map.runsEverything.some((p) => path.startsWith(p)) ||
      !map.scopable.some((p) => path.startsWith(p))
    ) {
      return { everything: true, reasons: [`${path}: everything runs`] };
    }
    const hit = dependents(path);
    for (const area of hit) areas.add(area);
    reasons.push(`${path}: ${hit.join(', ') || 'no named suite depends on it'}`);
  }
  return { everything: false, areas: [...areas].toSorted(), reasons };
};

/** The named suites a scope runs, in the manifest's order. */
export const suitesInScope = (scope: Scope, named: readonly string[]): string[] =>
  scope.everything ? [...named] : named.filter((s) => scope.areas.includes(areaOf(s)));

export const checkRuns = (
  check: string,
  scope: Scope,
  changed: readonly string[],
  map: ScopeMap,
  named: readonly string[],
): boolean => {
  if (!(SCOPED as readonly string[]).includes(check)) {
    throw new Error(`"${check}" is not scoped; it runs in full every time`);
  }
  if (scope.everything) return true;
  if (check === 'visual drift') {
    return changed.some((path) => map.visualDrift.some((p) => path.startsWith(p)));
  }
  return suitesInScope(scope, named).length > 0;
};

/** The run items one shard takes from the in-scope suites, split the way the runner splits. */
export const shardInScope = (scoped: readonly string[], root: string, shard: Part): string[] => {
  const plan = readPlan(join(root, 'tests/db/shard-plan.json'));
  return (
    assignShards(planItems(scoped, plan.parts), plan.seconds, shard.count)[shard.index - 1] ?? []
  );
};

/** Every path the pull request adds, changes, deletes or renames (both names), from the merge base. */
export const changedFiles = (base: string, cwd: string): string[] =>
  execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`], {
    cwd,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((p) => p !== '');

/** On a pull request, the base `scripts/merge-group.mjs` judges it against. */
const pullRequestBase = (root: string): string =>
  execFileSync(process.execPath, [join(root, 'scripts/merge-group.mjs'), 'base'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();

/**
 * Isolation runs when one of its own suites is reached; every one is also a named
 * suite (tests/ci/ci-scope.test.ts), so its area is read the same way.
 */
const isolationSuites = (root: string): string[] =>
  (
    JSON.parse(readFileSync(join(root, 'tests/db/isolation-suites.json'), 'utf8')) as {
      invariant?: string[];
    }
  ).invariant ?? [];

function main(argv: readonly string[]): number {
  const root = resolve(import.meta.dirname, '..');
  const split = argv.indexOf('--');
  const own = split === -1 ? argv : argv.slice(0, split);
  const command = split === -1 ? [] : argv.slice(split + 1);
  const [check = ''] = own;
  const shardAt = own.indexOf('--shard');
  if (command.length === 0 && !own.includes('--decide')) {
    throw new Error('give -- <command> to run, or --decide');
  }
  const event = process.env['GITHUB_EVENT_NAME'] ?? '';
  const map = readScopeMap(join(root, 'scripts/ci-scope.json'));
  const changed = event === 'pull_request' ? changedFiles(pullRequestBase(root), root) : [];
  const manifest = readNamedSuites(root);
  const named = [...manifest.invariant, ...manifest.conformance];
  const scope = scopeOf(event, changed, map, dependentsOf(root, named));
  const subject = check === 'isolation tests' ? isolationSuites(root) : named;
  let run = checkRuns(check, scope, changed, map, subject);
  const extra: string[] = [];
  if (check === 'database conformance' && run && !scope.everything && shardAt !== -1) {
    const scoped = suitesInScope(scope, named);
    run = shardInScope(scoped, root, parseShard(own[shardAt + 1])).length > 0;
    const path = join(mkdtempSync(join(tmpdir(), 'ci-scope-')), 'scoped-suites.json');
    const keep = (kind: readonly string[]): string[] => kind.filter((s) => scoped.includes(s));
    const body = { invariant: keep(manifest.invariant), conformance: keep(manifest.conformance) };
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
    extra.push('--manifest', path);
  }
  console.error(`ci-scope: ${check}: ${run ? 'runs' : 'not run, no mapped path changed'}`);
  if (!scope.everything) console.error(`ci-scope: areas ${scope.areas.join(', ') || 'none'}`);
  for (const reason of scope.reasons) console.error(`ci-scope:   ${reason}`);
  if (command.length === 0) {
    process.stdout.write(run ? 'run\n' : 'skip\n');
    return 0;
  }
  if (!run) return 0;
  const [bin = '', ...args] = command;
  const child = spawnSync(bin, [...args, ...extra], { stdio: 'inherit' });
  if (child.error !== undefined) throw child.error;
  return child.status ?? 1;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`ci-scope: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
