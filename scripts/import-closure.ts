// SPDX-License-Identifier: AGPL-3.0-only
// What a test file depends on, for checks by scope (scripts/ci-scope.ts):
// every file it reaches transitively, plus every repository path it names. The
// file is parsed with swc (the parser .dependency-cruiser.cjs uses), never a
// line pattern, and every string literal in it is read: one that resolves to a
// source file is followed as an import (static, dynamic or a URL it reads),
// one that names an existing path is recorded. A path built at run time is
// not seen here; the merge queue runs everything, which catches that.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { parseSync } from '@swc/core';

const ALIASES: Readonly<Record<string, string>> = {
  '@launchastro/ui': 'packages/ui/src/index.ts',
  '@launchastro/web': 'apps/web',
};
const EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.mjs', '.js', '/index.ts', '/index.tsx'];
const TOP = /^(?:apps|packages|tests|docs|deploy|presets|migrations|scripts)\//u;
const SOURCE = /\.(?:[cm]?[jt]sx?)$/u;

function resolveFile(root: string, base: string): string | undefined {
  for (const ext of EXTENSIONS) {
    const candidate = join(root, base + ext);
    if (existsSync(candidate) && statSync(candidate).isFile()) return relative(root, candidate);
  }
  // A `.js` specifier naming a `.ts` file, as NodeNext writes it.
  const swapped = base.replace(/\.js$/u, '.ts');
  if (swapped !== base && existsSync(join(root, swapped))) return swapped;
  return undefined;
}

function inside(root: string, path: string): string | undefined {
  const rel = relative(root, path);
  return rel.startsWith('..') || rel === '' ? undefined : rel;
}

/** Every string literal in a file's syntax tree, template literals without substitutions included. */
function strings(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) strings(child, out);
  } else if (typeof node === 'object' && node !== null) {
    const record = node as Record<string, unknown>;
    if (record['type'] === 'StringLiteral' && typeof record['value'] === 'string') {
      out.push(record['value']);
    }
    if (record['type'] === 'TemplateLiteral' && Array.isArray(record['quasis'])) {
      const quasis = record['quasis'] as { cooked?: string }[];
      if (quasis.length === 1 && typeof quasis[0]?.cooked === 'string') out.push(quasis[0].cooked);
    }
    for (const value of Object.values(record)) strings(value, out);
  }
  return out;
}

/** The files and paths one file names: strings resolving to source files, and existing paths. */
const parsed = new Map<string, { imports: string[]; paths: string[] }>();

function direct(root: string, file: string): { imports: string[]; paths: string[] } {
  const key = join(root, file);
  const known = parsed.get(key);
  if (known !== undefined) return known;
  const program = parseSync(readFileSync(join(root, file), 'utf8'), {
    syntax: 'typescript',
    tsx: file.endsWith('x'),
  });
  const imports: string[] = [];
  const paths: string[] = [];
  for (const value of strings(program.body)) {
    const alias = Object.entries(ALIASES).find(
      ([name]) => value === name || value.startsWith(`${name}/`),
    );
    const base = alias
      ? alias[1] + value.slice(alias[0].length)
      : value.startsWith('.')
        ? inside(root, join(root, dirname(file), value))
        : TOP.test(value)
          ? value
          : undefined;
    if (base === undefined) continue;
    const resolved = resolveFile(root, normalize(base));
    if (resolved !== undefined && SOURCE.test(resolved)) imports.push(resolved);
    else if (existsSync(join(root, base))) paths.push(normalize(base));
  }
  parsed.set(key, { imports, paths });
  return { imports, paths };
}

/** Every file reached from `entry` through imports, and every path any of them names. */
export function dependenciesOf(root: string, entry: string): string[] {
  const seen = new Set<string>();
  const named = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() ?? '';
    if (seen.has(file) || !SOURCE.test(file)) continue;
    seen.add(file);
    const { imports, paths } = direct(root, file);
    queue.push(...imports);
    for (const path of paths) named.add(path);
  }
  seen.delete(entry);
  return [...new Set([...seen, ...named])].toSorted();
}
