// SPDX-License-Identifier: AGPL-3.0-only
//
// A custom property a sheet reads but nobody declares is not an error in CSS:
// the declaration that reads it is dropped at computed-value time, silently.
// The dock's transitions read an undeclared `--dur-2` and so never ran. Every
// `var(--name)` without a fallback must be declared in a sheet, or written
// inline by a component's style object.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const files = (dir: string, ext: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith(ext))
    .map((name) => join(dir, name));

const SHEETS = [
  ...files('packages/ui/src/styles', '.css'),
  ...files('apps/web/src/styles', '.css'),
];
const SOURCES = [...files('packages/ui/src', '.tsx'), ...files('apps/web/src', '.tsx')];

/** Comments out, so a name in prose is neither a read nor a declaration. */
const uncommented = (sheet: string): string => sheet.replaceAll(/\/\*[\s\S]*?\*\//gu, '');

const names = (text: string, pattern: RegExp): string[] =>
  Array.from(text.matchAll(pattern), (match) => match[1] ?? '');

/** Reads with no fallback: `var(--name)`, spaces and case as a browser takes them. */
const unguardedReads = (sheet: string): string[] => names(sheet, /var\(\s*(--[\w-]+)\s*\)/giu);
const declared = (sheet: string): string[] => names(sheet, /(?:^|[{;\s])(--[\w-]+)\s*:/gu);
/** Names a component writes in a style object: `'--dock-w': ...`. */
const writtenInline = (source: string): string[] => names(source, /['"](--[\w-]+)['"]\s*:/gu);

describe('MP-3-2 motion tokens: every custom property a sheet reads is declared', () => {
  it('finds none undeclared across the shared and the slice sheets', () => {
    const sheets = SHEETS.map((path) => uncommented(readFileSync(path, 'utf8')));
    const known = new Set([
      ...sheets.flatMap((sheet) => declared(sheet)),
      ...SOURCES.flatMap((path) => writtenInline(readFileSync(path, 'utf8'))),
    ]);
    const read = new Set(sheets.flatMap((sheet) => unguardedReads(sheet)));
    expect([...read].filter((name) => !known.has(name))).toEqual([]);
  });

  it('reads through spaces, case and nesting, and not through a fallback or a comment', () => {
    const hostile = `a { b: var( --Spaced ); c: calc(1px + var(--nested)); d: var(--guarded, 2px); }`;
    expect(unguardedReads(hostile).toSorted()).toEqual(['--Spaced', '--nested']);
    expect(declared(':root{--a:1px;--b : 2px}\n  --c: 3px;').toSorted()).toEqual([
      '--a',
      '--b',
      '--c',
    ]);
    expect(unguardedReads(uncommented('/* var(--in-prose) */'))).toEqual([]);
  });
});
