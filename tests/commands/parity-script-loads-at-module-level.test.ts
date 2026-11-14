// SPDX-License-Identifier: AGPL-3.0-only
//
// Issue #2467: scripts/command-parity.mjs probes every API route as it loads,
// about 4-6 s. A test that loads it inside its own body spends that against the
// 5 s test timeout and fails on a loaded machine. Every test file loads it at
// module level instead, where loading is not timed per test.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from '@swc/core';
import { expect, it } from 'vitest';

const SCRIPT = /(^|\/)scripts\/command-parity\.mjs$/u;

// The few fields of swc's tree this check reads.
interface Node {
  readonly type?: string;
  readonly value?: unknown;
  readonly id?: Node;
  readonly init?: Node;
  readonly callee?: Node;
  readonly arguments?: { readonly expression?: Node }[];
  readonly expression?: Node;
  readonly span?: { readonly start: number };
  readonly body?: unknown;
}

const FUNCTIONS = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
  'FunctionDeclaration',
  'ClassMethod',
  'PrivateMethod',
  'MethodProperty',
  'GetterProperty',
  'SetterProperty',
]);

/** Every `const NAME = '<string>'` in the file, at any depth, so `import(NAME)` resolves. */
function constants(node: unknown, named = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(node)) {
    for (const one of node) constants(one, named);
    return named;
  }
  if (node === null || typeof node !== 'object') return named;
  const here = node as Node;
  if (here.type === 'VariableDeclarator') {
    const { id, init } = here;
    if (id?.type === 'Identifier' && init?.type === 'StringLiteral') {
      named.set(id.value as string, init.value as string);
    }
  }
  for (const [key, value] of Object.entries(here)) if (key !== 'span') constants(value, named);
  return named;
}

/** Each dynamic import of the parity script made inside a function, by its source offset. */
function loadsInsideAFunction(source: string, file: string): number[] {
  const module = parseSync(source, {
    syntax: 'typescript',
    tsx: file.endsWith('.tsx'),
    target: 'es2022',
  }) as unknown as Node;
  const named = constants(module.body);
  const found: number[] = [];
  const target = (argument: Node | undefined): string | undefined => {
    if (argument?.type === 'StringLiteral') return argument.value as string;
    if (argument?.type === 'Identifier') return named.get(argument.value as string);
    if (argument?.type === 'TsAsExpression' || argument?.type === 'ParenthesisExpression') {
      return target(argument.expression);
    }
    return undefined;
  };
  const walk = (node: unknown, depth: number): void => {
    if (Array.isArray(node)) {
      for (const one of node) walk(one, depth);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const here = node as Node;
    const inner = FUNCTIONS.has(here.type ?? '') ? depth + 1 : depth;
    if (here.type === 'CallExpression' && here.callee?.type === 'Import' && depth > 0) {
      const path = target(here.arguments?.[0]?.expression);
      if (path !== undefined && SCRIPT.test(path) && here.span !== undefined) {
        found.push(here.span.start);
      }
    }
    for (const [key, value] of Object.entries(here)) {
      if (key !== 'span') walk(value, inner);
    }
  };
  walk(module.body, 0);
  return found;
}

it('the check finds a parity load inside a test body and passes one at module level', () => {
  const inside = [
    "import { it } from 'vitest';",
    "it('x', async () => {",
    "  const path = '../../scripts/command-parity.mjs';",
    '  const { run } = await import(/* @vite-ignore */ path);',
    '  run();',
    '});',
  ].join('\n');
  const direct = "it('x', async () => { await import('../../scripts/command-parity.mjs'); });";
  const named = [
    "const PARITY = '../../scripts/command-parity.mjs';",
    "it('x', async () => { await import(PARITY); });",
  ].join('\n');
  const outside = [
    "const PARITY = '../../scripts/command-parity.mjs';",
    'const { run } = (await import(PARITY)) as { run: () => void };',
    "it('x', () => { run(); });",
  ].join('\n');
  const other = "it('x', async () => { await import('./another-module.ts'); });";
  expect(loadsInsideAFunction(inside, 'a.test.ts')).toHaveLength(1);
  expect(loadsInsideAFunction(direct, 'a.test.ts')).toHaveLength(1);
  expect(loadsInsideAFunction(named, 'a.test.ts')).toHaveLength(1);
  expect(loadsInsideAFunction(outside, 'a.test.ts')).toEqual([]);
  expect(loadsInsideAFunction(other, 'a.test.ts')).toEqual([]);
});

// Reads every test file, so it names its own timeout for a loaded machine.
it('no test file loads the parity script inside a function', { timeout: 30_000 }, () => {
  const offenders = readdirSync('tests', { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .map((file) => [file, readFileSync(file, 'utf8')] as const)
    .filter(([, source]) => source.includes('command-parity.mjs'))
    .filter(([file, source]) => loadsInsideAFunction(source, file).length > 0)
    .map(([file]) => file)
    .toSorted();
  expect(offenders, 'load scripts/command-parity.mjs at module level (#2467)').toEqual([]);
});
