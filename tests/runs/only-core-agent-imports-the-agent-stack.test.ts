// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R4, the stack's boundary in the source. The agent loop runs on the
// pinned LangChain stack in one package, so a callback, a tracer or a retry
// cannot enter where its guards do not stand:
// - only `packages/core-agent` names `langchain`, `@langchain/*` or
//   `langsmith`;
// - nothing that ships names `@langchain/core/context`, which registers
//   configure hooks and sets context variables (design F4), and neither
//   `core-agent` nor the worker calls `registerConfigureHook` or
//   `setContextVariable`;
// - nothing that ships names a provider SDK (`openai`, `@anthropic-ai/*`, a
//   LangChain provider package): a model call leaves only through custody.
//
// dependency-cruiser leaves `node_modules` out of its graph, so it cannot
// hold these. Each file is parsed with swc, the parser the cruise uses, and
// every string literal and identifier in it is read: a static, dynamic,
// re-exported or required specifier is seen however it is quoted or spaced.
// Hostile: planted sources in each of those forms are refused.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from '@swc/core';
import { describe, expect, it } from 'vitest';

const STACK = /^(langchain|langsmith)(\/|$)|^@langchain\//u;
const CONTEXT = /^@langchain\/core\/context$/u;
const PROVIDER = /^(openai|@anthropic-ai\/.+|@langchain\/(openai|anthropic))(\/|$)/u;
const WRITERS = new Set(['registerConfigureHook', 'setContextVariable']);

/** Every string literal and identifier in a source file, read from its syntax tree. */
function namesIn(source: string, file: string): { strings: string[]; identifiers: string[] } {
  const tree = parseSync(source, {
    syntax: 'typescript',
    tsx: file.endsWith('.tsx'),
    target: 'es2022',
  });
  const strings: string[] = [];
  const identifiers: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const shaped = node as {
      type?: unknown;
      value?: unknown;
      quasis?: unknown;
      expressions?: unknown;
    };
    if (shaped.type === 'StringLiteral' && typeof shaped.value === 'string')
      strings.push(shaped.value);
    if (shaped.type === 'Identifier' && typeof shaped.value === 'string')
      identifiers.push(shaped.value);
    if (
      shaped.type === 'TemplateLiteral' &&
      Array.isArray(shaped.expressions) &&
      shaped.expressions.length === 0
    ) {
      const [only] = shaped.quasis as { cooked?: string }[];
      if (typeof only?.cooked === 'string') strings.push(only.cooked);
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(tree);
  return { strings, identifiers };
}

/** What a file may not name, by where it is. */
function faultsIn(file: string, source: string): string[] {
  const { strings, identifiers } = namesIn(source, file);
  const agent = file.startsWith('packages/core-agent/');
  const faults: string[] = [];
  for (const name of strings) {
    if (STACK.test(name) && !agent) faults.push(`${file}: ${name}`);
    if (CONTEXT.test(name) || PROVIDER.test(name)) faults.push(`${file}: ${name}`);
  }
  if (agent || file.startsWith('apps/worker/')) {
    for (const name of identifiers) if (WRITERS.has(name)) faults.push(`${file}: ${name}`);
  }
  return [...new Set(faults)];
}

function sources(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    if (entry === 'node_modules' || entry.startsWith('.')) return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(?:[cm]?[jt]sx?)$/u.test(entry) && !entry.endsWith('.d.ts') ? [path] : [];
  });
}

describe('only core-agent imports the agent stack', () => {
  it('no shipped file outside core-agent names the stack, its context writers or a provider SDK', () => {
    const files = ['apps', 'packages', 'scripts'].flatMap((root) => sources(root));
    const agent = files.filter((file) => file.startsWith('packages/core-agent/'));
    expect(agent.length, 'core-agent itself is read').toBeGreaterThan(3);
    expect(faultsIn(agent[0] ?? '', "import { createAgent } from 'langchain';")).toEqual([]);
    expect(files.flatMap((file) => faultsIn(file, readFileSync(file, 'utf8')))).toEqual([]);
  });

  it('a stack import outside core-agent is seen however it is written', () => {
    const planted = [
      "import { createAgent } from 'langchain';",
      'export * from "@langchain/langgraph";',
      'const traced = await import(`langsmith`);',
      "const core = require( /* why */ '@langchain/core/messages' );",
    ].join('\n');
    expect(faultsIn('apps/worker/planted.ts', planted).toSorted()).toEqual(
      [
        'apps/worker/planted.ts: langchain',
        'apps/worker/planted.ts: @langchain/langgraph',
        'apps/worker/planted.ts: langsmith',
        'apps/worker/planted.ts: @langchain/core/messages',
      ].toSorted(),
    );
  });

  it('the context writers and a provider SDK are refused, in core-agent too', () => {
    const planted = [
      "import { registerConfigureHook } from '@langchain/core/context';",
      "import OpenAI from 'openai';",
      "import { Anthropic } from '@anthropic-ai/sdk';",
      "import { ChatOpenAI } from '@langchain/openai';",
      'registerConfigureHook({});',
    ].join('\n');
    expect(faultsIn('packages/core-agent/src/planted.ts', planted).toSorted()).toEqual(
      [
        'packages/core-agent/src/planted.ts: @langchain/core/context',
        'packages/core-agent/src/planted.ts: openai',
        'packages/core-agent/src/planted.ts: @anthropic-ai/sdk',
        'packages/core-agent/src/planted.ts: @langchain/openai',
        'packages/core-agent/src/planted.ts: registerConfigureHook',
      ].toSorted(),
    );
  });
});
