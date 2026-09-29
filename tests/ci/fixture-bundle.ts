// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b2 (T4-R3): no fixture path in the shipped bundle.
//
//   node tests/ci/fixture-bundle.ts [dist]     (default apps/web/dist)
//
// The selectors are derived, not listed by hand: the word `fixture`, and for
// every test-only module under `tests/fixture/` and `tests/support/` its
// repository path and, when it has one, its hyphenated stem
// (`declining-reporter`). Every file the build wrote is searched for each,
// ignoring case, and the module graph Rollup recorded (`module-graph.json`) is
// read for any module under `tests/`, which catches a fixture module whose
// strings minifying removed. A generic `tests/` is not a selector: the bundle
// quotes test file names in its own comments.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE_DIRECTORIES = ['tests/fixture', 'tests/support'];

export interface Hit {
  readonly file: string;
  readonly selector: string;
}

/** The strings that would select a fixture path, derived from the fixture modules. */
export function fixtureSelectors(root: string = ROOT): readonly string[] {
  const selectors = new Set(['fixture']);
  for (const directory of FIXTURE_DIRECTORIES) {
    for (const file of readdirSync(join(root, directory))) {
      if (file.includes('.test.')) continue;
      selectors.add(`${directory}/${file}`);
      const stem = file.replace(/\.[cm]?[jt]sx?$/u, '');
      if (stem.includes('-')) selectors.add(stem);
    }
  }
  return [...selectors];
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
