// SPDX-License-Identifier: AGPL-3.0-only
// One file per named suite (MERGE-PLAN item 5, ORCH91 MAGNETS step 1).
//
// The per-area lists under tests/db/named-suites/ and the isolation list were
// edited by most pull requests, so two that each added a suite conflicted.
// Each suite now has a file of its own, at its path below tests/ plus .json:
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

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** Every file below `dir`, as paths relative to it, sorted. */
function filesBelow(dir: string, prefix = ''): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .toSorted(byName)
    .flatMap((entry) => {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      return entry.isDirectory() ? filesBelow(dir, rel) : [rel];
    });
}

/** One suite file, refused unless it holds exactly a known kind, a boolean isolation and a reason. */
function readSuiteFile(root: string, rel: string): SuiteFile {
  const file = `${SUITES}/${rel}`;
  if (!rel.endsWith('.json')) {
    refuse(file, `is not a .json file; ${SUITES}/ holds one <path below tests/>.json per suite`);
  }
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
  if (typeof why !== 'string' || why.trim() === '') {
    refuse(file, '"why" must say what the suite proves');
  }
  return { suite: `tests/${rel.slice(0, -'.json'.length)}`, kind, isolation };
}

/** Every suite file under `root`; the old lists named in `old` may not sit beside them. */
export function readSuiteFiles(root: string, old: readonly string[]): SuiteFile[] {
  for (const path of old) {
    if (existsSync(join(root, path))) {
      refuse(
        path,
        `is still here beside ${SUITES}/; each suite has its own file now, so remove it`,
      );
    }
  }
  return filesBelow(join(root, SUITES)).map((rel) => readSuiteFile(root, rel));
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
  manifest: {
    comment: readonly string[];
    invariant: readonly string[];
    conformance: readonly string[];
  },
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
  writeFileSync(
    join(root, SUITES_HISTORY),
    `${JSON.stringify({ comment: manifest.comment }, null, 2)}\n`,
  );
  const back = readSuiteFiles(root, []);
  const of = (kind: SuiteFile['kind']) => back.filter((e) => e.kind === kind).map((e) => e.suite);
  if (
    !sameMembers(of('invariant'), manifest.invariant) ||
    !sameMembers(of('conformance'), manifest.conformance) ||
    !sameMembers(
      back.filter((e) => e.isolation).map((e) => e.suite),
      [...isolated],
    )
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

function suitesIn(root: string, read: Readers): { named: string[]; isolation: string[] } {
  const { invariant, conformance } = read.readNamedSuites(root);
  const isolation = read.readIsolationSuites(root).invariant;
  return {
    named: [...new Set([...invariant, ...conformance])],
    isolation: [...new Set(isolation)],
  };
}

/**
 * Throws naming each suite the base commit named, or marked isolation, that the checkout no
 * longer does, unless its test file was deleted between the base and HEAD; else says the counts.
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
  // No renames: a renamed test file counts as deleted at its old path.
  const diff = ['diff', '--name-only', '--no-renames', '--diff-filter=D', '-z', base, 'HEAD'];
  const deleted = gitIn(root, diff).toString().split('\0').filter(Boolean);
  const named = droppedSuites(before.named, after.named, deleted);
  const isolation = droppedSuites(before.isolation, after.isolation, deleted);
  if (named.length + isolation.length > 0) {
    throw new Error(
      [
        `the head drops suites the base ${base} kept, and their test files are still here:`,
        ...named.map((suite) => `  no longer named: ${suite}`),
        ...isolation.map((suite) => `  no longer marked isolation: ${suite}`),
        `Name each again under ${SUITES}/, or delete its test file in the same change.`,
      ].join('\n'),
    );
  }
  const counts = (of: 'named' | 'isolation') =>
    `${of} ${String(before[of].length)} -> ${String(after[of].length)}`;
  return `every suite the base kept is kept: ${counts('named')}, ${counts('isolation')}.`;
}
