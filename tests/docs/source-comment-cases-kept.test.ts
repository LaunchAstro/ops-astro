// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'vite';
import { expect, it } from 'vitest';

const BASE = '5116fbdd6dde77b88f4dd0716ce79ef9d8703898';
const FILE = 'tests/docs/source-comments.test.ts';
type Node = Record<string, unknown>;

/** Count the cases declared in one suite, including every literal `.each` row. */
function casesIn(source: string): number {
  const parsed = parseSync(FILE, source, { lang: 'ts' });
  expect(parsed.errors).toEqual([]);
  let count = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const node = value as Node;
    if (node['type'] === 'CallExpression') {
      const callee = node['callee'] as Node;
      const args = node['arguments'] as Node[];
      if (
        callee['type'] === 'Identifier' &&
        callee['name'] === 'it' &&
        args[0]?.['type'] === 'Literal'
      ) {
        count += 1;
      } else if (callee['type'] === 'CallExpression' && args[0]?.['type'] === 'Literal') {
        const each = callee['callee'] as Node;
        if (each['type'] === 'MemberExpression' && (each['object'] as Node)['name'] === 'it') {
          const rows = (callee['arguments'] as Node[])[0]?.['elements'] as unknown[] | undefined;
          if ((each['property'] as Node)['name'] === 'each' && rows !== undefined)
            count += rows.length;
        }
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(parsed.program);
  return count;
}

it('current-main source-comment cases survive and the ledger names current main', () => {
  const root = join(import.meta.dirname, '../..');
  const before = execFileSync('git', ['show', `${BASE}:${FILE}`], { cwd: root, encoding: 'utf8' });
  const after = readFileSync(join(root, FILE), 'utf8');
  expect(casesIn(after)).toBe(casesIn(before));
  expect(after).toContain("it('reads a phrase that wraps from one comment line to the next'");
  const ledger = JSON.parse(
    readFileSync(join(root, 'tests/docs/test-case-counts.json'), 'utf8'),
  ) as {
    before: { head: string };
  };
  expect(ledger.before.head).toBe(BASE);
});
