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
// `visualDrift` lists what the visual drift job builds and reads. A check under
// `queueOnly` (CI-SPEED, light pull requests) never runs on a pull request: the
// merge queue, the only way into main, runs it in full, as do a push and any
// other or empty event.
//
// A pre-check batch (#1918) is the one pull request that decides as a merge
// group: one labelled `precheck-batch` whose head is a branch of this
// repository, so a fork cannot ask for it. Every check then runs in full,
// unscoped, so the batch's green covers what the queue runs. The label only
// widens what runs; an event file that is named but does not read fails.

// A scoped job wraps each heavy step in this, so no step carries a condition
// that could skip a merge group (tests/ci/merge-group-workflows.test.ts): the
// job always runs and reports its required name, the wrapped command runs or
// the step says why not, and on a group or a push it always runs. A selector
// that fails fails the step.
//
// Usage: node scripts/ci-scope.ts <check> [--shard i/n] -- <command> [args...]
//        node scripts/ci-scope.ts <check> --decide   (prints run or skip)
//   GITHUB_EVENT_NAME  the event; anything but pull_request runs everything.
//   GITHUB_EVENT_PATH, GITHUB_REPOSITORY  on a pull request, whether it is a batch.
//   A queue-only check reads no change: on a pull request it says it runs in
//   the merge queue and passes (`--decide` prints skip).
//   On a pull request the base is `node scripts/merge-group.mjs base`.
//   A scoped database shard gets `--manifest <in-scope suites>` appended.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { areaOf } from './ci-areas.ts';
import { dependenciesOf } from './import-closure.ts';
import { assignShards, parseShard, planItems, readPlan, type Part } from './db-shards.ts';
import { readIsolationSuites, readNamedSuites } from './named-suites.ts';

export interface ScopeMap {
  readonly scopable: readonly string[];
  readonly runsEverything: readonly string[];
  readonly visualDrift: readonly string[];
  readonly queueOnly: readonly string[];
  readonly alwaysRunTests: readonly string[];
}

/** A field of an object, or undefined when either is not there. */
const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/** Two strings equal without case, as ci.yml's `contains` and `==` compare them. */
const same = (value: unknown, text: string): boolean =>
  typeof value === 'string' && value.toLowerCase() === text.toLowerCase();

/**
 * The event the checks decide on: the one given, but a pull request labelled `precheck-batch`
 * whose head is a branch of `repository` decides as a batch, which runs everything. It reads the
 * label and the head as ci.yml's shard condition does, so the two agree.
 */
export const decidingEvent = (event: string, payload: unknown, repository: string): string => {
  if (event !== 'pull_request' || repository === '') return event;
  const pull = field(payload, 'pull_request');
  const labels = field(pull, 'labels');
  const labelled =
    Array.isArray(labels) && labels.some((label) => same(field(label, 'name'), PRECHECK_BATCH));
  const own = same(field(field(field(pull, 'head'), 'repo'), 'full_name'), repository);
  return labelled && own ? BATCH_EVENT : event;
};

/** The event file GitHub wrote, or undefined when none is named. One that is named must read. */
const readEvent = (path: string): unknown =>
  path === '' ? undefined : (JSON.parse(readFileSync(path, 'utf8')) as unknown);

/** The areas of the named suites that depend on a path. */
export type Dependents = (path: string) => readonly string[];

export type Scope =
  | { readonly everything: true; readonly reasons: readonly string[] }
  | { readonly everything: false; readonly areas: readonly string[]; readonly reasons: string[] };

const SCOPED = ['database conformance', 'isolation tests', 'visual drift'] as const;

export const PRECHECK_BATCH = 'precheck-batch';
/** The event a pre-check batch decides as: not a pull request, so everything runs. */
const BATCH_EVENT = `pull_request labelled ${PRECHECK_BATCH}`;

const isPrefixList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((p) => typeof p === 'string' && p !== '');

/** The kept map, refusing anything malformed rather than reading it as empty. */
export const readScopeMap = (path: string): ScopeMap => {
  const map = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  for (const key of ['scopable', 'runsEverything', 'visualDrift', 'queueOnly', 'alwaysRunTests']) {
    if (!isPrefixList(map[key]))
      throw new Error(`${path}: ${key} must be a list of non-empty strings`);
  }
  return map as unknown as ScopeMap;
};

/**
 * Which areas depend on a path, from every named suite's import closure. A suite
 * depends on itself, on each file it reaches and on each path it names; a named
 * directory, or a named path the head no longer has, covers every path under it.
 */
export const dependentsOf = (root: string, suites: readonly string[]): Dependents => {
  const files = new Map<string, Set<string>>();
  const directories: [string, string][] = [];
  for (const suite of new Set(suites.map((s) => s.split('#')[0] ?? s))) {
    const area = areaOf(suite);
    for (const dep of [suite, ...dependenciesOf(root, suite)]) {
      // A named path the head no longer has may have been a file or a directory, so it covers
      // both: a deleted fixture directory still reaches the deleted files under it.
      const gone = !existsSync(join(root, dep));
      const directory = gone || statSync(join(root, dep)).isDirectory();
      if (directory) directories.push([`${dep.replace(/\/+$/u, '')}/`, area]);
      if (gone || !directory) files.set(dep, (files.get(dep) ?? new Set()).add(area));
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
const isolationSuites = (root: string): string[] => readIsolationSuites(root).invariant;

/** Run the explicit repository contracts without consulting imports or PR labels. */
function runPins(root: string, command: readonly string[], tests: readonly string[]): number {
  if (tests.length === 0) throw new Error('alwaysRunTests must not be empty');
  for (const path of tests) {
    if (!path.startsWith('tests/') || !/\.test\.tsx?$/u.test(path) || !existsSync(join(root, path)))
      throw new Error(`alwaysRunTests: not a test file: ${path}`);
  }
  console.error(`ci-scope: pin and count tests: always runs ${tests.length} test files`);
  return decideOrRun(true, command, [...tests]);
}

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
  const map = readScopeMap(join(root, 'scripts/ci-scope.json'));
  if (check === 'pin and count tests') return runPins(root, command, map.alwaysRunTests);
  const given = process.env['GITHUB_EVENT_NAME'] ?? '';
  const payload = given === 'pull_request' ? readEvent(process.env['GITHUB_EVENT_PATH'] ?? '') : {};
  const event = decidingEvent(given, payload, process.env['GITHUB_REPOSITORY'] ?? '');
  if (map.queueOnly.includes(check)) {
    const run = event !== 'pull_request';
    const why = 'deferred on a pull request; it runs in full in the merge queue';
    console.error(`ci-scope: ${check}: ${run ? `${event || 'no event'}: runs in full` : why}`);
    return decideOrRun(run, command, []);
  }
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
  return decideOrRun(run, command, extra);
}

/** Prints the decision when there is no command; otherwise runs it when it runs, passing its exit code. */
function decideOrRun(run: boolean, command: readonly string[], extra: readonly string[]): number {
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
