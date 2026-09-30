// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b2 (T4-R3): no fixture path in the shipped bundle.
//
//   node tests/ci/fixture-bundle.ts [dist]     (default apps/web/dist)
//
// The selectors are derived, not listed by hand: the word `fixture`, and for
// every test-only module under `tests/fixture/` and `tests/support/` its
// repository path and, when it has one, its hyphenated stem
// (`declining-reporter`), unless a shipped module under `apps/` or `packages/`
// has the same stem (`sign-in`): the app says that word for its own module, so
// it selects nothing, and the fixture is still caught by its path and in the
// module graph. Every test sign-in value is the one marker
// (`tests/support/marker.ts`) plus random bytes made at run time, so no value
// exists to copy, and the marker is a selector (the owner's option A). Every
// file the build wrote is searched for each,
// ignoring case, and the module graph Rollup recorded (`module-graph.json`) is
// read for any module under `tests/`, which catches a fixture module whose
// strings minifying removed. A generic `tests/` is not a selector: the bundle
// quotes test file names in its own comments.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { TEST_ONLY_MARKER } from '../support/marker.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE_DIRECTORIES = ['tests/fixture', 'tests/support'];
const SHIPPED_DIRECTORIES = ['apps', 'packages'];
const NOT_SOURCE = new Set(['node_modules', 'dist']);

export interface Hit {
  readonly file: string;
  readonly selector: string;
}

/** The strings that would select a fixture path, derived from the fixture modules. */
export function fixtureSelectors(root: string = ROOT): readonly string[] {
  const shipped = new Set(
    SHIPPED_DIRECTORIES.flatMap((directory) => sourceFilesUnder(join(root, directory))).map(
      (path) => stemOf(basename(path)),
    ),
  );
  const selectors = new Set(['fixture', TEST_ONLY_MARKER]);
  for (const directory of FIXTURE_DIRECTORIES) {
    for (const file of readdirSync(join(root, directory))) {
      if (file.includes('.test.')) continue;
      selectors.add(`${directory}/${file}`);
      const stem = stemOf(file);
      // The app says a shared stem for its own module, so the bare word selects nothing.
      if (stem.includes('-') && !shipped.has(stem)) selectors.add(stem);
    }
  }
  return [...selectors];
}

function stemOf(file: string): string {
  return file.replace(/\.[cm]?[jt]sx?$/u, '');
}

/** Source files under `directory`, leaving out installed packages and build output. */
function sourceFilesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return NOT_SOURCE.has(entry.name) ? [] : sourceFilesUnder(path);
    return /\.[cm]?[jt]sx?$/u.test(entry.name) ? [path] : [];
  });
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** Every selector found in the built bundle at `dist`, one hit per file and selector. */
export function scanBundle(dist: string, root: string = ROOT): readonly Hit[] {
  const selectors = fixtureSelectors(root);
  const hits: Hit[] = [];
  for (const path of filesUnder(dist).toSorted()) {
    const file = relative(dist, path);
    const text = readFileSync(path, 'utf8').toLowerCase();
    for (const selector of selectors) {
      if (text.includes(selector.toLowerCase())) hits.push({ file, selector });
    }
    if (file !== 'module-graph.json') continue;
    const graph = JSON.parse(readFileSync(path, 'utf8')) as { modules?: Record<string, string[]> };
    const entries = Object.entries(graph.modules ?? {});
    const modules = [...entries.map(([id]) => id), ...entries.flatMap(([, imports]) => imports)];
    for (const id of new Set(modules)) {
      const known = hits.some((hit) => hit.file === file && hit.selector === id);
      if (id.startsWith('tests/') && !known) hits.push({ file, selector: id });
    }
  }
  return hits;
}

if (import.meta.main) {
  const dist = resolve(process.argv[2] ?? join(ROOT, 'apps/web/dist'));
  const hits = scanBundle(dist);
  for (const hit of hits) console.log(`fixture-bundle: ${hit.file} carries ${hit.selector}`);
  const searched = `${String(filesUnder(dist).length)} files, ${String(fixtureSelectors().length)} selectors`;
  console.log(
    `fixture-bundle: ${hits.length === 0 ? 'nothing found' : `${String(hits.length)} hits`} in ${dist} (${searched})`,
  );
  process.exitCode = hits.length === 0 ? 0 : 1;
}
