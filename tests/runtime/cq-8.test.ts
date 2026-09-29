// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-8, the parts a reader can check without a database: the runtime
// transactions are split into named steps short enough to review, and every
// advisory lock goes through one helper.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseSync } from 'vite';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const RUNTIME = join(ROOT, 'packages', 'core-runtime', 'src');

/**
 * Each function in `file` that has a body, with its length in lines from its
 * first line to its closing brace: top-level declarations, and functions held
 * in a top-level `const`. A nested helper counts inside the function holding it.
 */
function functionLengths(file: string): readonly { name: string; lines: number }[] {
  const text = readFileSync(file, 'utf8');
  const lineOf = (at: number) => text.slice(0, at).split('\n').length;
  const found: { name: string; lines: number }[] = [];
  const measure = (name: string, node: { start: number; end: number }) =>
    found.push({ name, lines: lineOf(node.end) - lineOf(node.start) + 1 });
  for (const top of parseSync(file, text, { lang: 'ts' }).program.body) {
    const statement =
      top.type === 'ExportNamedDeclaration' && top.declaration ? top.declaration : top;
    if (statement.type === 'FunctionDeclaration' && statement.body)
      measure(statement.id?.name ?? '(anonymous)', statement);
    if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations) {
        const value = declaration.init;
        if (value?.type === 'ArrowFunctionExpression' || value?.type === 'FunctionExpression')
          measure(
            declaration.id.type === 'Identifier' ? declaration.id.name : '(pattern)',
            declaration,
          );
      }
    }
  }
  return found;
}

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('CQ-8 runtime structure', () => {
  it('CQ-8 function size: no function in decide, pickup, handback or heartbeat is longer than 120 lines', () => {
    const long = ['decide.ts', 'pickup.ts', 'handback.ts', 'heartbeat.ts'].flatMap((name) =>
      functionLengths(join(RUNTIME, name))
        .filter((fn) => fn.lines > 120)
        .map((fn) => `${name} ${fn.name} ${String(fn.lines)}`),
    );
    expect(long).toEqual([]);
    // The measure itself: it finds the transactions it is meant to bound.
    const named = functionLengths(join(RUNTIME, 'handback.ts')).map((fn) => fn.name);
    expect(named).toContain('handback');
  });

  it('CQ-8 function size: recovery is split into the classifier, lease retirement, authority loss and the sweep, none over 600 lines', () => {
    const parts = sourceFiles(join(RUNTIME, 'recovery'));
    expect(parts.map((file) => relative(RUNTIME, file)).toSorted()).toEqual([
      'recovery/authority-loss.ts',
      'recovery/classifier.ts',
      // T3e1: a drop, and the work coming back from it.
      'recovery/drop.ts',
      'recovery/lease-retirement.ts',
      // T3d1: a person's recorded outcome, and the pass's reconciliation phase.
      'recovery/outcome.ts',
      'recovery/reconcile.ts',
      // T3b: the reconciliation pass's lease-expiry phase.
      'recovery/sweep.ts',
    ]);
    for (const file of [...parts, join(RUNTIME, 'recovery.ts')]) {
      expect(readFileSync(file, 'utf8').split('\n').length, file).toBeLessThanOrEqual(600);
    }
  });

  it('CQ-8 one lock path: pg_advisory_xact_lock appears once in product code, in the one helper', () => {
    const product = [join(ROOT, 'packages'), join(ROOT, 'apps')].flatMap(sourceFiles);
    const takers = product.flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      const hits = text.match(/pg_(?:try_)?advisory(?:_xact)?_lock(?:_shared)?\b/gu) ?? [];
      return hits.map(() => relative(ROOT, file));
    });
    expect(takers).toEqual(['packages/core-records/src/tenancy/database.ts']);
  });

  it('CQ-8 one lock path: the runtime, the envelope and placement take advisory locks only through the helper', () => {
    // A lock taken outside `acquire` or `advisoryLock` fails the scan above;
    // this names the callers, so a new one is a decision rather than a drift.
    const product = [join(ROOT, 'packages'), join(ROOT, 'apps')].flatMap(sourceFiles);
    const callers = product
      .filter((file) => /\badvisoryLock\(/u.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file))
      .toSorted();
    expect(callers).toEqual([
      'packages/core-commands/src/commands/prepare.ts',
      'packages/core-records/src/tasks/placement.ts',
      'packages/core-records/src/tenancy/database.ts',
      'packages/core-runtime/src/locks.ts',
    ]);
  });

  it('CQ-8 one lock path: locks.ts states where the command-layer locks sit in the order', () => {
    const text = readFileSync(join(RUNTIME, 'locks.ts'), 'utf8');
    expect(text).toMatch(/command-layer locks/iu);
    expect(text).toMatch(/before any lock `acquire` takes/iu);
  });
});
