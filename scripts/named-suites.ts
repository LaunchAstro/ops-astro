// SPDX-License-Identifier: AGPL-3.0-only
// The named suites scripts/db-conformance.mjs runs, read from either layout.
//
// tests/db/named-suites.json is a file every lane edits, so at a later cut it
// is split into one file per area (code-factory METHOD Phase 2 step 6):
//
//   tests/db/named-suites/_history.json   { "comment": [...] } only
//   tests/db/named-suites/<area>.json     comment, invariant, conformance
//
// where <area> is areaOf(path) for every suite the file names. Every reader
// goes through readNamedSuites, so neither layout is read by hand. While the
// folder is absent the single file is read exactly as before, order kept.
// Once it exists, the folder is the manifest, and a folder that cannot be
// trusted is refused with the file named, rather than read in part: a suite
// dropped from the manifest is a suite no required check runs.
//
// Usage: node scripts/named-suites.ts split [--check] | kept <base-sha>
//   kept     fails on a suite the base kept that the head drops (keptSuites).
//   split    writes the folder from the single file, proves the folder reads
//            back as the same manifest, then removes the single file.
//   --check  the same round trip in a temp folder; writes nothing here.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { areaOf } from './ci-areas.ts';
import {
  FOLDER,
  ISOLATION,
  keptSuites,
  message,
  readSuiteFiles,
  refuse,
  SINGLE,
  SUITES,
  SUITES_HISTORY,
  writeSuiteFiles,
} from './suite-files.ts';

export interface NamedSuites {
  comment: string[];
  invariant: string[];
  conformance: string[];
}

export interface SplitSuites {
  history: { comment: string[] };
  areas: Record<string, { invariant: string[]; conformance: string[] }>;
}

const HISTORY = '_history.json';
const KINDS = ['comment', 'invariant', 'conformance'] as const;
type Kind = (typeof KINDS)[number];

const repoRoot = resolve(import.meta.dirname, '..');

/** The manifest's path under `root`: the folder when it exists, else the single file. */
export const manifestPathIn = (root: string): string =>
  existsSync(join(root, SUITES))
    ? join(root, SUITES)
    : existsSync(join(root, FOLDER))
      ? join(root, FOLDER)
      : join(root, SINGLE);

const listOf = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

/** The named suites under `root`, from the folder when it exists, else the single file. */
export function readNamedSuites(root: string): NamedSuites {
  if (existsSync(join(root, SUITES))) {
    const files = readSuiteFiles(root, [FOLDER, SINGLE, ISOLATION]);
    const of = (kind: 'invariant' | 'conformance') =>
      files.filter((entry) => entry.kind === kind).map((entry) => entry.suite);
    const history = join(root, SUITES_HISTORY);
    const comment = existsSync(history)
      ? listOf((JSON.parse(readFileSync(history, 'utf8')) as Record<string, unknown>)['comment'])
      : [];
    return {
      comment,
      invariant: of('invariant').toSorted(),
      conformance: of('conformance').toSorted(),
    };
  }
  if (existsSync(join(root, FOLDER))) return readFolder(root);
  const manifest = JSON.parse(readFileSync(join(root, SINGLE), 'utf8')) as Record<string, unknown>;
  return {
    comment: listOf(manifest['comment']),
    invariant: listOf(manifest['invariant']),
    conformance: listOf(manifest['conformance']),
  };
}

/** One folder file's lists, refused unless it is a .json object of string arrays under known keys. */
function readFile(root: string, file: string): Record<Kind, string[]> {
  if (!file.endsWith('.json') || !statSync(join(root, file)).isFile()) {
    refuse(file, 'is not a .json file; the folder holds only the history and one file per area');
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
  const allowed: readonly string[] = file.endsWith(`/${HISTORY}`) ? ['comment'] : KINDS;
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      refuse(file, `has an unknown key "${key}"; it may hold ${allowed.join(', ')}`);
    }
  }
  const lists = {} as Record<Kind, string[]>;
  for (const kind of KINDS) {
    const value = body[kind] ?? [];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      refuse(file, `"${kind}" must be an array of strings`);
    }
    lists[kind] = value as string[];
  }
  return lists;
}

function readFolder(root: string): NamedSuites {
  const comment: string[] = [];
  const areaComments: string[] = [];
  const suites = { invariant: [] as string[], conformance: [] as string[] };
  const seen = new Map<string, string>();
  for (const name of readdirSync(join(root, FOLDER)).toSorted()) {
    const file = `${FOLDER}/${name}`;
    const lists = readFile(root, file);
    if (name === HISTORY) {
      comment.push(...lists.comment);
      continue;
    }
    const area = name.slice(0, -'.json'.length);
    for (const kind of ['invariant', 'conformance'] as const) {
      for (const suite of lists[kind]) {
        const before = seen.get(suite);
        if (before !== undefined)
          refuse(file, `has ${suite} named twice: in ${kind}, and in ${before}`);
        seen.set(suite, `${file} ${kind}`);
        let own: string;
        try {
          own = areaOf(suite);
        } catch (error) {
          refuse(file, message(error));
        }
        if (own !== area)
          refuse(file, `names ${suite}, which belongs to ${own}.json, not ${area}.json`);
        suites[kind].push(suite);
      }
    }
    if (lists.invariant.length + lists.conformance.length === 0) {
      refuse(file, 'names no suite; remove a file whose area has none');
    }
    areaComments.push(...lists.comment);
  }
  return {
    comment: [...comment, ...areaComments],
    invariant: suites.invariant.toSorted(),
    conformance: suites.conformance.toSorted(),
  };
}

/** The manifest as one history file and one file per area, an area only when it has a suite. */
export function splitNamedSuites(manifest: NamedSuites): SplitSuites {
  const areas: SplitSuites['areas'] = {};
  for (const kind of ['invariant', 'conformance'] as const) {
    for (const suite of manifest[kind].toSorted()) {
      const area = areaOf(suite);
      areas[area] ??= { invariant: [], conformance: [] };
      areas[area][kind].push(suite);
    }
  }
  return { history: { comment: [...manifest.comment] }, areas };
}

/** True when the joined folder holds the same suites per kind, each once, and every comment line. */
const same = (original: NamedSuites, joined: NamedSuites): boolean =>
  JSON.stringify(original.comment) === JSON.stringify(joined.comment) &&
  (['invariant', 'conformance'] as const).every(
    (kind) => JSON.stringify(original[kind].toSorted()) === JSON.stringify(joined[kind]),
  );

/**
 * Splits `root`'s single file into the folder, proves the folder reads back as
 * the same manifest, then removes the single file. On any failure the folder
 * it wrote is removed and the single file is left as it was.
 */
export async function splitToFolder(root: string): Promise<NamedSuites> {
  const folder = join(root, FOLDER);
  if (existsSync(folder)) throw new Error(`${FOLDER} already exists; split reads only ${SINGLE}`);
  if (existsSync(join(root, SUITES))) {
    throw new Error(
      `${SUITES} already exists: each suite has its own file, so there is nothing to split`,
    );
  }
  const original = readNamedSuites(root);
  const { history, areas } = splitNamedSuites(original);
  const { format, resolveConfig } = await import('prettier');
  const config = await resolveConfig(join(repoRoot, SINGLE));
  mkdirSync(folder);
  try {
    const files: [string, object][] = [
      [HISTORY, history],
      ...Object.entries(areas).map(([area, lists]): [string, object] => [`${area}.json`, lists]),
    ];
    const texts = await Promise.all(
      files.map(([name, body]) =>
        format(JSON.stringify(body, null, 2), { ...config, filepath: join(folder, name) }),
      ),
    );
    files.forEach(([name], i) => writeFileSync(join(folder, name), texts[i] ?? ''));
    const joined = readNamedSuites(root);
    if (!same(original, joined)) {
      throw new Error(`${FOLDER} does not read back as ${SINGLE}; nothing was kept`);
    }
  } catch (error) {
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
  rmSync(join(root, SINGLE));
  return original;
}

/** The isolation suites under `root`: the suite files marked so, or else the isolation list. */
export function readIsolationSuites(root: string): { invariant: string[] } {
  if (existsSync(join(root, SUITES))) {
    const files = readSuiteFiles(root, [FOLDER, SINGLE, ISOLATION]);
    return { invariant: files.filter((entry) => entry.isolation).map((entry) => entry.suite) };
  }
  const manifest = JSON.parse(readFileSync(join(root, ISOLATION), 'utf8')) as Record<
    string,
    unknown
  >;
  return { invariant: listOf(manifest['invariant']) };
}

/** Converts the per-area lists and the isolation list to one file per suite, then removes them. */
export function suitesToFiles(root: string): void {
  const manifest = readNamedSuites(root);
  const isolation = readIsolationSuites(root).invariant;
  const why = `named in ${FOLDER}/ before each suite had its own file; its reason is in ${SUITES_HISTORY}`;
  writeSuiteFiles(root, manifest, isolation, why);
  rmSync(join(root, FOLDER), { recursive: true, force: true });
  rmSync(join(root, ISOLATION), { force: true });
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv[0] === 'kept' && argv.length <= 2) {
    const readers = { readNamedSuites, readIsolationSuites };
    console.log(`named-suites: ${keptSuites(argv[1], process.env['GITHUB_EVENT_NAME'], readers)}`);
    return;
  }
  if (argv[0] !== 'split' || argv.length > 2 || (argv.length === 2 && argv[1] !== '--check')) {
    throw new Error('usage: node scripts/named-suites.ts split [--check] | kept <base-sha>');
  }
  let root = repoRoot;
  if (argv[1] === '--check') {
    root = mkdtempSync(join(tmpdir(), 'named-suites-check-'));
    mkdirSync(join(root, 'tests/db'), { recursive: true });
    copyFileSync(join(repoRoot, SINGLE), join(root, SINGLE));
  }
  try {
    const manifest = await splitToFolder(root);
    const areas = readdirSync(join(root, FOLDER)).length - 1;
    const counts = `${String(manifest.invariant.length)} invariant, ${String(manifest.conformance.length)} conformance`;
    const where =
      root === repoRoot ? `wrote ${FOLDER}/ and removed ${SINGLE}` : 'checked in a temp folder';
    console.log(
      `named-suites: ${where}: ${counts}, ${String(areas)} area files, the join is the same.`,
    );
  } finally {
    if (root !== repoRoot) rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`named-suites: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
