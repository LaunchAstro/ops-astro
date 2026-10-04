// SPDX-License-Identifier: AGPL-3.0-only
// One file per named suite (MERGE-PLAN item 5, ORCH91 MAGNETS step 1): two
// pull requests that each added a suite to the per-area lists under
// tests/db/named-suites/ or the isolation list conflicted, so each suite now
// has a file of its own, at its path below tests/ plus .json:
//
//   tests/db/suites/api/a.test.ts.json   { "kind", "isolation", "why" }
//
// names tests/api/a.test.ts. `kind` is invariant or conformance, `isolation`
// says whether `isolation tests` runs it too, and `why` says what it proves.
// A file is read whole or refused with its name: a suite read in part is a
// suite no required check runs. scripts/named-suites.ts is the one reader.
//
// keptSuites runs `named-suites.ts kept <base>`: deleting a file here drops a
// suite with no list diff, so it fails on a suite the base commit named or
// marked isolation that the head does not, unless its test file was deleted.
// A renamed test file takes its suite, kind and isolation to the new path.
// It reads the base from git in any layout it has had; what it cannot, fails.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const SINGLE = 'tests/db/named-suites.json';
export const FOLDER = 'tests/db/named-suites';
export const ISOLATION = 'tests/db/isolation-suites.json';
export const SUITES = 'tests/db/suites';
/** The per-area lists' history, kept as it was when each suite got its own file. */
export const SUITES_HISTORY = 'tests/db/suites-history.json';
const KEYS = ['kind', 'isolation', 'why'] as const;

export interface SuiteFile {
  suite: string;
  kind: 'invariant' | 'conformance';
  isolation: boolean;
}

export function refuse(file: string, why: string): never {
  throw new Error(`${file} ${why}`);
}

export const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Every file below `root`'s SUITES, as paths relative to it, sorted; a symlink is refused. */
function filesBelow(root: string, prefix = ''): string[] {
  return readdirSync(join(root, SUITES, prefix), { withFileTypes: true })
    .toSorted((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((entry) => {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) refuse(`${SUITES}/${rel}`, 'is a symlink, not a suite file');
      return entry.isDirectory() ? filesBelow(root, rel) : [rel];
    });
}

/** One suite file, refused unless it names a test file and holds a known kind, isolation and why. */
function readSuiteFile(root: string, rel: string): SuiteFile {
  const file = `${SUITES}/${rel}`;
  if (!/\.test\.tsx?\.json$/u.test(rel)) refuse(file, 'is not <a test file below tests/>.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, file), 'utf8'));
  } catch (error) {
    refuse(file, `is not valid JSON: ${message(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    refuse(file, 'must hold a JSON object');
  }
  const body = parsed as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!(KEYS as readonly string[]).includes(key)) {
      refuse(file, `has an unknown key "${key}"; it may hold ${KEYS.join(', ')}`);
    }
  }
  const { kind, isolation, why } = body;
  if (kind !== 'invariant' && kind !== 'conformance') {
    refuse(file, '"kind" must be "invariant" or "conformance"');
  }
  if (typeof isolation !== 'boolean') refuse(file, '"isolation" must be true or false');
  if (typeof why !== 'string' || why.trim() === '') refuse(file, '"why" must say what it proves');
  return { suite: `tests/${rel.slice(0, -'.json'.length)}`, kind, isolation };
}

/** Every suite file under `root`; the old lists named in `old` may not sit beside them. */
export function readSuiteFiles(root: string, old: readonly string[]): SuiteFile[] {
  for (const path of old) {
    if (existsSync(join(root, path))) refuse(path, `is still here beside ${SUITES}/; remove it`);
  }
  return filesBelow(root).map((rel) => readSuiteFile(root, rel));
}

/** Whether two lists hold the same entries, in any order. */
const sameMembers = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.toSorted().every((entry, i) => entry === b.toSorted()[i]);

/**
 * Writes one file per suite in `manifest`, marking those in `isolation`, and
 * the history to SUITES_HISTORY, then reads the files back and throws unless
 * they hold the same suites, kinds and isolation set.
 */
export function writeSuiteFiles(
  root: string,
  manifest: Record<'comment' | 'invariant' | 'conformance', readonly string[]>,
  isolation: readonly string[],
  why: string,
): void {
  const isolated = new Set(isolation);
  for (const kind of ['invariant', 'conformance'] as const) {
    for (const suite of manifest[kind]) {
      if (!suite.startsWith('tests/')) refuse(suite, 'is not below tests/');
      const path = join(root, SUITES, `${suite.slice('tests/'.length)}.json`);
      mkdirSync(dirname(path), { recursive: true });
      const body = { kind, isolation: isolated.has(suite), why };
      writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
    }
  }
  const history = { comment: manifest.comment };
  writeFileSync(join(root, SUITES_HISTORY), `${JSON.stringify(history, null, 2)}\n`);
  const back = readSuiteFiles(root, []);
  const of = (kind: SuiteFile['kind']) => back.filter((e) => e.kind === kind).map((e) => e.suite);
  const marked = back.filter((e) => e.isolation).map((e) => e.suite);
  if (
    !sameMembers(of('invariant'), manifest.invariant) ||
    !sameMembers(of('conformance'), manifest.conformance) ||
    !sameMembers(marked, [...isolated])
  ) {
    throw new Error(`${SUITES}/ does not read back as the lists it was written from`);
  }
}

/** The suites on the base that the head no longer names, leaving out those whose test file was deleted. */
export function droppedSuites(
  base: readonly string[],
  head: readonly string[],
  deleted: readonly string[],
): string[] {
  const named = new Set(head);
  const gone = new Set(deleted);
  return base.filter((suite) => !named.has(suite) && !gone.has(suite));
}

/** Everything the manifest has been held in, in any layout. */
const MANIFEST = [SINGLE, FOLDER, ISOLATION, SUITES, SUITES_HISTORY];
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** Git's output in `cwd`; a failure names the command and its exit, not what git printed. */
function gitIn(cwd: string, args: readonly string[], input?: string): Buffer {
  const run = spawnSync('git', args, { cwd, input, maxBuffer: 1024 * 1024 * 1024 });
  if (run.error !== undefined || run.status !== 0) {
    throw new Error(`git ${args[0] ?? ''} failed (exit ${String(run.status)})`);
  }
  return run.stdout;
}

const hasCommit = (cwd: string, sha: string): boolean =>
  spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd }).status === 0;

/** The base, refused unless it is a full commit id other than all zeros. */
function baseOf(value: string | undefined, event: string): string {
  if (value === undefined || !COMMIT_ID.test(value)) {
    throw new Error(
      `the base ${JSON.stringify(value ?? '')} is not a 40 or 64 hex commit id, so no suite can be checked`,
    );
  }
  if (/^0+$/u.test(value)) {
    throw new Error(
      event === 'push'
        ? 'no base commit: the push to main has an all-zero `before`, which GitHub sends when a push creates the branch; this runs on pushes to main only, so the push is not one it can check'
        : `no base commit: the ${event} event's base is all zeros, so there is nothing to compare the head with`,
    );
  }
  return value;
}

/** Fetches the base when the checkout lacks it: the gate's checkout is depth 1. */
function fetchBase(root: string, base: string): void {
  if (hasCommit(root, base)) return;
  const shallow = gitIn(root, ['rev-parse', '--is-shallow-repository']).toString().trim();
  const fetch = ['fetch', '--no-tags', '--quiet', ...(shallow === 'true' ? ['--depth=1'] : [])];
  try {
    gitIn(root, [...fetch, 'origin', base]);
  } catch (error) {
    throw new Error(`could not fetch the base commit ${base} from origin: ${message(error)}`, {
      cause: error,
    });
  }
  if (!hasCommit(root, base)) throw new Error(`the base ${base} is not a commit`);
}

/** Writes the base's manifest files under `into` from git: the base is never checked out. */
function materialise(root: string, base: string, into: string): void {
  const listing = gitIn(root, ['ls-tree', '-r', '-z', '--full-tree', base, '--', ...MANIFEST])
    .toString()
    .split('\0')
    .filter(Boolean);
  if (listing.length === 0) throw new Error(`it holds none of ${MANIFEST.join(', ')}`);
  const entries = listing.map((line) => {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/su.exec(line);
    if (match === null) throw new Error(`git ls-tree printed an entry that is not a file`);
    return { oid: match[1] ?? '', path: match[2] ?? '' };
  });
  // One git process for every blob: the per-suite layout is hundreds of files.
  const out = gitIn(root, ['cat-file', '--batch'], entries.map((e) => `${e.oid}\n`).join(''));
  let at = 0;
  for (const { oid, path } of entries) {
    const end = out.indexOf(0x0a, at);
    const header = /^([0-9a-f]+) blob (\d+)$/u.exec(out.subarray(at, end).toString());
    if (header?.[1] !== oid) throw new Error(`git cat-file could not read ${path}`);
    const size = Number(header[2]);
    mkdirSync(dirname(join(into, path)), { recursive: true });
    writeFileSync(join(into, path), out.subarray(end + 1, end + 1 + size));
    at = end + 1 + size + 1;
  }
}

/** The one reader's two lists: named-suites.ts passes its own, so nothing here reads by hand. */
export interface Readers {
  readNamedSuites: (root: string) => { invariant: string[]; conformance: string[] };
  readIsolationSuites: (root: string) => { invariant: string[] };
}

function suitesIn(root: string, read: Readers) {
  const { invariant, conformance } = read.readNamedSuites(root);
  return {
    invariant: new Set(invariant),
    named: [...new Set([...invariant, ...conformance])],
    isolation: [...new Set(read.readIsolationSuites(root).invariant)],
  };
}

/** The test files deleted between `base` and HEAD, and those renamed, old path to new. */
function changesSince(root: string, base: string) {
  const diff = ['diff', '--name-status', '-M', '-l0', '--diff-filter=DR', '-z', base, 'HEAD'];
  const fields = gitIn(root, diff).toString().split('\0').filter(Boolean);
  const deleted: string[] = [];
  const renamed = new Map<string, string>();
  for (let at = 0; at < fields.length; at += fields[at] === 'D' ? 2 : 3) {
    const [status = '', path = '', to = ''] = fields.slice(at, at + 3);
    if (status === 'D') deleted.push(path);
    else if (/^R\d+$/u.test(status) && to !== '') renamed.set(path, to);
    else throw new Error('git diff printed an entry that is not a deletion or a rename');
  }
  return { deleted, renamed };
}

/**
 * Throws naming each suite the base named, or marked isolation, that the checkout does not at its
 * path, or with its kind at its renamed test file's, unless that was deleted; else says the counts.
 */
export function keptSuites(value: string | undefined, event = 'local', read: Readers): string {
  const base = baseOf(value, event);
  const root = gitIn(process.cwd(), ['rev-parse', '--show-toplevel']).toString().trim();
  fetchBase(root, base);
  const into = mkdtempSync(join(tmpdir(), 'named-suites-base-'));
  let before: ReturnType<typeof suitesIn>;
  try {
    materialise(root, base, into);
    before = suitesIn(into, read);
  } catch (error) {
    const why = message(error).replaceAll(`${into}/`, '');
    throw new Error(`at the base ${base}, ${why}`, { cause: error });
  } finally {
    rmSync(into, { recursive: true, force: true });
  }
  const after = suitesIn(root, read);
  const { deleted, renamed } = changesSince(root, base);
  const moved = (suites: string[]) => suites.map((suite) => renamed.get(suite) ?? suite);
  const named = droppedSuites(moved(before.named), after.named, deleted);
  const isolation = droppedSuites(moved(before.isolation), after.isolation, deleted);
  const kind = [...renamed]
    .filter(([from, to]) => before.named.includes(from) && after.named.includes(to))
    .filter(([from, to]) => before.invariant.has(from) !== after.invariant.has(to))
    .map(([, to]) => to);
  const from = new Map([...renamed].map(([old, to]) => [to, old]));
  const shown = (suite: string) => (from.has(suite) ? `${from.get(suite)} -> ${suite}` : suite);
  if (named.length + isolation.length + kind.length > 0) {
    throw new Error(
      [
        `the head drops suites the base ${base} kept, and their test files are still here:`,
        ...named.map((suite) => `  no longer named: ${shown(suite)}`),
        ...isolation.map((suite) => `  no longer marked isolation: ${shown(suite)}`),
        ...kind.map((suite) => `  named as another kind: ${shown(suite)}`),
        `Name each again under ${SUITES}/, or delete its test file in the same change.`,
      ].join('\n'),
    );
  }
  const counts = (of: 'named' | 'isolation') =>
    `${of} ${String(before[of].length)} -> ${String(after[of].length)}`;
  return `every suite the base kept is kept: ${counts('named')}, ${counts('isolation')}.`;
}
