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

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

function refuse(file: string, why: string): never {
  throw new Error(`${file} ${why}`);
}

const message = (error: unknown): string =>
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
