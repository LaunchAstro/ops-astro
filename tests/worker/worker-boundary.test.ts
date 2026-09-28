// SPDX-License-Identifier: AGPL-3.0-only
//
// T2b's invariant `worker_boundary` (split section 1.2), its structural half.
//
// The worker holds no database privilege because it never connects: its entry
// point's import graph reaches no database module, no `postgres` or `pg`
// driver, and no text naming `DATABASE_URL` (spike RN-04). The shipped graph
// cannot reach the declining fixture reporter, and, as its own negative case,
// the test build can. The cruiser rules that hold both in CI are planted
// against here so a rule that stops firing goes red.
//
// The process half, a real worker process proposing through a served API, is
// `tests/api/t2b-worker.test.ts`.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DECLINING_REPORTER } from '../support/declining-reporter.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const WORKER_ENTRY = 'apps/worker/main.ts';
const FIXTURE_REPORTER = 'tests/support/declining-reporter.ts';

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
function importGraph(entry: string): { files: Set<string>; packages: Set<string> } {
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

describe('worker_boundary: the structure', () => {
  it('the worker entry exists and is its own process entry', () => {
    expect(existsSync(join(ROOT, WORKER_ENTRY))).toBe(true);
    expect(readFileSync(join(ROOT, WORKER_ENTRY), 'utf8')).toMatch(/import\.meta\.main/u);
  });

  it('reaches no database module and no postgres driver', () => {
    const { files, packages } = importGraph(WORKER_ENTRY);
    const database = [...files].filter((file) =>
      /^packages\/core-(records|runtime|commands)\//u.test(file),
    );
    expect(database).toStrictEqual([]);
    expect([...packages].filter((name) => /^(postgres|pg)(\/|$)/u.test(name))).toStrictEqual([]);
  });

  it('neither reads nor requires DATABASE_URL', () => {
    const { files } = importGraph(WORKER_ENTRY);
    const naming = [...files].filter((file) =>
      readFileSync(join(ROOT, file), 'utf8').includes('DATABASE_URL'),
    );
    expect(naming).toStrictEqual([]);
  });

  it('builds its transport on the command line’s agent entry, not a second client', () => {
    const { files } = importGraph(WORKER_ENTRY);
    expect(files.has('apps/cli/client.ts')).toBe(true);
    const fetches = [...files].filter(
      (file) =>
        file !== 'apps/cli/client.ts' && /\bfetch\(/u.test(readFileSync(join(ROOT, file), 'utf8')),
    );
    expect(fetches).toStrictEqual([]);
  });

  it('the shipped graph cannot reach the fixture reporter', () => {
    expect(importGraph(WORKER_ENTRY).files.has(FIXTURE_REPORTER)).toBe(false);
  });

  it('the test build can: its own negative case', () => {
    expect(importGraph('tests/worker/worker-boundary.test.ts').files.has(FIXTURE_REPORTER)).toBe(
      true,
    );
    expect(DECLINING_REPORTER.observe({ kind: 'synthetic_comment' })).toBeNull();
  });
});

describe('worker_boundary: the cruiser rules fire', () => {
  const runner = join(ROOT, 'scripts/deps-cruise.mjs');
  const config = readFileSync(join(ROOT, '.dependency-cruiser.cjs'), 'utf8');
  const REPORTER = 'export const R = { observe: () => null };\n';

  function cruise(files: Record<string, string>): { status: number | null; output: string } {
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

  const base = {
    [FIXTURE_REPORTER]: REPORTER,
    'packages/core-records/src/index.ts': 'export const records = 1;\n',
  };

  it('is green when only a test reaches the fixture reporter', () => {
    const answer = cruise({
      ...base,
      'apps/worker/main.ts': 'export const worker = 1;\n',
      'tests/worker/uses.test.ts': "import { R } from '../support/declining-reporter.ts';\nR;\n",
    });
    expect(answer.output).toContain('the structural rules hold');
    expect(answer.status).toBe(0);
  });

  it('is red when anything shippable imports the fixture reporter', () => {
    const answer = cruise({
      ...base,
      'apps/worker/main.ts': "import { R } from '../../tests/support/declining-reporter.ts';\nR;\n",
    });
    expect(answer.status).toBe(1);
    expect(answer.output).toContain('shippable-never-reaches-tests');
  });

  it('is red when a package imports the fixture reporter', () => {
    const answer = cruise({
      ...base,
      'apps/worker/main.ts': 'export const worker = 1;\n',
      'packages/core-records/src/index.ts':
        "import { R } from '../../../tests/support/declining-reporter.ts';\nexport const records = R;\n",
    });
    expect(answer.status).toBe(1);
    expect(answer.output).toContain('shippable-never-reaches-tests');
  });

  it('is red when the worker reaches a database package', () => {
    const answer = cruise({
      ...base,
      'apps/worker/main.ts':
        "import { records } from '../../packages/core-records/src/index.ts';\nrecords;\n",
    });
    expect(answer.status).toBe(1);
    expect(answer.output).toContain('worker-holds-no-database');
  });
});
