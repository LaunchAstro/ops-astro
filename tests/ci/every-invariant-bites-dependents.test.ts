// SPDX-License-Identifier: AGPL-3.0-only
//
// REV257C ruling: a part's unwire may turn red only the parts built on its
// code, its declared `dependents` in parts.json. The exact list is proven
// locally (unwire-dependents-exact.test.mjs); here, each declared dependent's
// suite, with the test modules it imports, names a symbol the part's own
// commits added to product code.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PARTS } from './self-test/catalogue.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const git = (args: readonly string[]): string =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

/** The files' text with every test module they import, followed within tests/. */
function suiteOf(files: readonly string[]): string {
  const seen = new Set<string>();
  const todo = files.map((file) => resolve(ROOT, file));
  for (let file = todo.pop(); file !== undefined; file = todo.pop()) {
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const [, from = ''] of readFileSync(file, 'utf8').matchAll(/from '(\.[^']+)'/gu)) {
      const next = resolve(file, '..', from);
      if (next.startsWith(resolve(ROOT, 'tests'))) todo.push(next);
    }
  }
  return [...seen].map((file) => readFileSync(file, 'utf8')).join('\n');
}

describe('every_invariant_bites: a part’s declared dependents', () => {
  it('declares as dependents only other parts whose suite reaches code the part added', () => {
    for (const part of PARTS) {
      const added = part.commits
        .map((commit) => git(['show', '--format=', commit, '--', '.', ':!tests']))
        .join('\n')
        .split('\n')
        .filter((line) => line.startsWith('+'));
      for (const { part: id, reaches, why } of part.dependents ?? []) {
        const dependent = PARTS.find((one) => one.id === id && one.planted === undefined);
        expect(dependent !== undefined && id !== part.id, `${part.id} declares ${id}`).toBe(true);
        expect(why.length, `${part.id} ${id} says why`).toBeGreaterThan(0);
        expect(
          added.some((line) => line.includes(reaches)),
          `${part.id} added ${reaches}`,
        ).toBe(true);
        const suite = suiteOf(dependent?.files ?? []);
        expect(suite.includes(reaches), `${id}'s suite reaches ${reaches}`).toBe(true);
      }
    }
  });
});
