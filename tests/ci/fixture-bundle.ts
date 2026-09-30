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
// it selects nothing, and the fixture is still caught by its path, in the
// module graph and by its own quoted values that carry the stem
// (`test-sign-in-es256`), wherever they were copied. Every file the build wrote is searched for each,
// ignoring case, and the module graph Rollup recorded (`module-graph.json`) is
// read for any module under `tests/`, which catches a fixture module whose
// strings minifying removed. A generic `tests/` is not a selector: the bundle
// quotes test file names in its own comments.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { parseAst } from 'vite';

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
  const selectors = new Set(['fixture']);
  for (const directory of FIXTURE_DIRECTORIES) {
    for (const file of readdirSync(join(root, directory))) {
      if (file.includes('.test.')) continue;
      selectors.add(`${directory}/${file}`);
      const stem = stemOf(file);
      if (!stem.includes('-')) continue;
      // The app says a shared stem for its own module, so the bare word selects
      // nothing; the test-only file's own quoted values that carry it still do.
      const shared = shipped.has(stem);
      const found = shared ? valuesCarrying(join(root, directory, file), stem) : [stem];
      for (const selector of found) selectors.add(selector);
    }
  }
  return [...selectors];
}

/**
 * The string values in a test-only file that carry `stem` and are more than it,
 * as the language reads them: Vite's parser decodes every quote style, escape
 * and template part, and a concatenation or template of constant parts is read
 * assembled, so no spelling or split of a value hides it. One it cannot
 * assemble whose constant text carries the stem stops the scan.
 */
function valuesCarrying(path: string, stem: string): string[] {
  const values: string[] = [];
  const carries = (v: string): boolean => v.toLowerCase().includes(stem);
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const { type, value, operator } = node as {
      type?: unknown;
      value?: unknown;
      operator?: unknown;
    };
    if (type === 'Literal' && typeof value === 'string') values.push(value);
    if (type === 'TemplateElement') values.push((value as { cooked?: string }).cooked ?? '');
    if ((type === 'BinaryExpression' && operator === '+') || type === 'TemplateLiteral') {
      const assembled = folded(node);
      if (assembled !== undefined) values.push(assembled);
      else if (carries(constantText(node)))
        throw new Error(
          `${path}: a value carrying "${stem}" is assembled from parts not known here`,
        );
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(parseAst(readFileSync(path, 'utf8'), { lang: 'ts' }));
  return values.filter((v) => carries(v) && v.toLowerCase() !== stem);
}

type Node = {
  type?: string;
  value?: unknown;
  operator?: string;
  left?: unknown;
  right?: unknown;
  expression?: unknown;
  quasis?: { value: { cooked?: string } }[];
  expressions?: unknown[];
};

/** A string expression's value when every part of it is a constant, else undefined. */
function folded(node: unknown): string | undefined {
  const n = node as Node;
  if (n.type === 'Literal') return typeof n.value === 'string' ? n.value : undefined;
  if (n.type === 'ParenthesizedExpression') return folded(n.expression);
  if (n.type === 'BinaryExpression' && n.operator === '+') {
    const [left, right] = [folded(n.left), folded(n.right)];
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (n.type !== 'TemplateLiteral') return undefined;
  const parts = (n.expressions ?? []).map((expression) => folded(expression));
  if (parts.includes(undefined)) return undefined;
  return (n.quasis ?? [])
    .map((quasi, i) => `${quasi.value.cooked ?? ''}${parts[i] ?? ''}`)
    .join('');
}

/** Every constant string under `node`, joined: what an unassembled value is built from. */
function constantText(node: unknown): string {
  if (typeof node !== 'object' || node === null) return '';
  const n = node as Node;
  if (n.type === 'Literal') return typeof n.value === 'string' ? n.value : '';
  if (n.type === 'TemplateElement') return (n.value as { cooked?: string }).cooked ?? '';
  return Object.values(node)
    .map((child) => constantText(child))
    .join('');
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
