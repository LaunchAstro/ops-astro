// SPDX-License-Identifier: AGPL-3.0-only
//
// The graph a process loads at run time, walked from its entry, and the
// dependency cruise run on planted files, for the boundary proofs
// (`tests/worker/worker-boundary.test.ts`, `model-agent-boundary.test.ts`).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

export const ROOT: string = resolve(import.meta.dirname, '../..');

/**
 * Every import specifier a file names that loads a module at run time. A
 * type-only import or export is erased before the code runs and loads nothing,
 * so it is not an edge of the graph the process executes. Static imports are
 * read at the start of a line, so a planted import inside a string is not one.
 */
function specifiers(text: string): readonly string[] {
  const found: string[] = [];
  const pattern =
    /^(?:import|export)\s+(?!type\s)[^'"]*?from\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|^import\s+['"]([^'"]+)['"]/gmu;
  for (const match of text.matchAll(pattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier !== undefined) found.push(specifier);
  }
  return found;
}

/** The repository files and bare packages reachable from `entry`. */
export function importGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of specifiers(readFileSync(join(ROOT, file), 'utf8'))) {
      if (!specifier.startsWith('.')) {
        packages.add(specifier.replace(/^node:/u, ''));
        continue;
      }
      const target = relative(ROOT, resolve(ROOT, dirname(file), specifier));
      if (existsSync(join(ROOT, target))) pending.push(target);
      else throw new Error(`${file} imports ${specifier}, which does not resolve`);
    }
  }
  return { files, packages };
}

const runner = join(ROOT, 'scripts/deps-cruise.mjs');
const config = readFileSync(join(ROOT, '.dependency-cruiser.cjs'), 'utf8');

/** The repository's cruise over a tree holding only `files`. */
export function cruise(files: Record<string, string>): { status: number | null; output: string } {
  const root = mkdtempSync(join(tmpdir(), 't2b-cruise-'));
  try {
    writeFileSync(join(root, '.dependency-cruiser.cjs'), config);
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    }
    const run = spawnSync(process.execPath, [runner, 'apps', 'tests', 'packages'], {
      env: { ...process.env, DEPS_CRUISE_ROOT: root },
      encoding: 'utf8',
    });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
