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
  readonly callee?: Node;
  readonly arguments?: { readonly expression?: Node }[];
  readonly expression?: Node;
  readonly span?: { readonly start: number };
  readonly body?: unknown;
  readonly expressions?: unknown[];
  readonly quasis?: { readonly cooked?: string | null }[];
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

/** The path a written-out import names: a string, or a template with nothing interpolated. */
function written(argument: Node | undefined): string | undefined {
  if (argument?.type === 'StringLiteral') return argument.value as string;
  if (argument?.type === 'TemplateLiteral' && argument.expressions?.length === 0) {
    return argument.quasis?.[0]?.cooked ?? undefined;
  }
  if (argument?.type === 'TsAsExpression' || argument?.type === 'ParenthesisExpression') {
    return written(argument.expression);
  }
  return undefined;
}

/**
 * Each dynamic import made inside a function that may load the parity script, by its source
 * offset: one that names the script, or, in a file that names the script anywhere, one whose
 * path is not written out. No name is resolved, so no scope or shadowing hides a load; an
 * import of another module by a name in such a file counts too (S2468-1, S2468-2).
 */
function loadsInsideAFunction(source: string, file: string): number[] {
  const module = parseSync(source, {
    syntax: 'typescript',
    tsx: file.endsWith('.tsx'),
    target: 'es2022',
  }) as unknown as Node;
  const named = source.includes('command-parity.mjs');
  const found: number[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (Array.isArray(node)) {
      for (const one of node) walk(one, depth);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const here = node as Node;
    const inner = FUNCTIONS.has(here.type ?? '') ? depth + 1 : depth;
    if (here.type === 'CallExpression' && here.callee?.type === 'Import' && depth > 0) {
      const path = written(here.arguments?.[0]?.expression);
      const loads = path === undefined ? named : SCRIPT.test(path);
      if (loads && here.span !== undefined) found.push(here.span.start);
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
  const template = "it('x', async () => { await import(`../../scripts/command-parity.mjs`); });";
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
  expect(loadsInsideAFunction(template, 'a.test.ts')).toHaveLength(1);
  expect(loadsInsideAFunction(named, 'a.test.ts')).toHaveLength(1);
  expect(loadsInsideAFunction(outside, 'a.test.ts')).toEqual([]);
  expect(loadsInsideAFunction(other, 'a.test.ts')).toEqual([]);
});

// S2468-1, S2468-2: a path held in a name counts whatever the name is bound to, in a file that
// names the script, so no scope, shadowing or declaration site hides a load.
it('the check counts a named path wherever and however the name is bound', () => {
  const parity = "'../../scripts/command-parity.mjs'";
  const siblings = [
    `it('parity', async () => { const path = ${parity}; await import(path); });`,
    "it('unrelated', async () => { const path = './another-module.ts'; await import(path); });",
  ].join('\n');
  const loop = `it('x', async () => { for (const path = ${parity};;) { await import(path); break; } });`;
  const cases = `it('x', async () => { switch (1) { case 1: const path = ${parity}; await import(path); break; } });`;
  const shadow = "const path = './another-module.ts';";
  const shadowedLoop = `it('x', async () => { ${shadow} for (const path = ${parity};;) { await import(path); break; } });`;
  const shadowedCase = `it('x', async () => { ${shadow} switch (1) { case 1: const path = ${parity}; await import(path); break; } });`;
  // The unrelated sibling counts too: the check fails loudly rather than miss a load.
  expect(loadsInsideAFunction(siblings, 'a.test.ts')).toHaveLength(2);
  for (const one of [loop, cases, shadowedLoop, shadowedCase]) {
    expect(loadsInsideAFunction(one, 'a.test.ts'), one).toHaveLength(1);
  }
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
