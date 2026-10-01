// SPDX-License-Identifier: AGPL-3.0-only
//
// T3b's structural half: `T3 shipped graph` for the sweeper's side, and the
// import-boundary barrier reinstated as a second, independent check.
//
// The sweep runs in the API (spike RN-04 gives the worker no database), so the
// API's entry graph is the one that must not reach the declining reporter
// that drives `liability_unknown` in tests; the test build can, as its own
// negative case. The cruiser carries a second rule that names the reporter
// itself, and it fires with the general "nothing shippable imports tests/"
// rule deleted, so one rule relaxed is not the barrier gone. And no toggle:
// the only writes of `liability_unknown` in shipped code are observe's cost
// above the hold and the sweep, and neither reads a setting to decide it.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DECLINING_REPORTER } from '../support/declining-reporter.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURE_REPORTER = 'tests/support/declining-reporter.ts';
const RULE = 'fixture-reporter-is-test-only';

/** Repository files reachable from `entry` by run-time imports (type-only ones load nothing). */
function reachable(entry: string): Set<string> {
  const files = new Set<string>();
  const pending = [entry];
  const pattern =
    /^(?:import|export)\s+(?!type\s)[^'"]*?from\s+['"](\.[^'"]+)['"]|\bimport\(\s*['"](\.[^'"]+)['"]\s*\)|^import\s+['"](\.[^'"]+)['"]/gmu;
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const match of readFileSync(join(ROOT, file), 'utf8').matchAll(pattern)) {
      const target = relative(
        ROOT,
        resolve(ROOT, dirname(file), match[1] ?? match[2] ?? match[3] ?? ''),
      );
      if (existsSync(join(ROOT, target))) pending.push(target);
    }
  }
  return files;
}

function sources(directory: string): string[] {
  return readdirSync(join(ROOT, directory), { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.tsx?$/u.test(path) && !path.includes('node_modules'))
    .map((path) => join(directory, path));
}

describe('T3 shipped graph: the sweeper side', () => {
  it('the API entry, which runs the sweep, cannot reach the declining reporter', () => {
    const graph = reachable('apps/api/server.ts');
    expect(graph.has('packages/core-runtime/src/recovery/sweep.ts')).toBe(true);
    expect(graph.has(FIXTURE_REPORTER)).toBe(false);
  });

  it('the test build can: its own negative case', () => {
    expect(reachable('tests/runtime/t3b-sweeper.test.ts').has(FIXTURE_REPORTER)).toBe(true);
    expect(DECLINING_REPORTER.observe({ kind: 'synthetic_comment' })).toBeNull();
    // The fixture only declines to say what a step cost: no kill, no crash seam.
    expect(Object.keys(DECLINING_REPORTER).toSorted()).toStrictEqual(['estimate', 'observe']);
  });

  it('no toggle: only observe above the hold and the sweep write liability_unknown, and neither reads a setting for it', () => {
    const writers = [...sources('apps'), ...sources('packages')].filter((file) =>
      /set\s+state\s*=\s*'liability_unknown'/u.test(readFileSync(join(ROOT, file), 'utf8')),
    );
    expect(writers.toSorted()).toStrictEqual([
      // AW-01: the broker writes a model call's own ledger state (O6, O9) when
      // the provider may have acted, never an attempt's; it reads no setting either.
      'packages/core-custody/src/broker-settle.ts',
      'packages/core-custody/src/broker.ts',
      'packages/core-runtime/src/budget.ts',
      'packages/core-runtime/src/recovery/classifier.ts',
    ]);
    for (const file of writers) {
      expect(readFileSync(join(ROOT, file), 'utf8')).not.toMatch(/process\.env|import\.meta\.env/u);
    }
  });
});

describe('the import-boundary barrier, a second and independent rule', () => {
  const require = createRequire(import.meta.url);
  const config = require(join(ROOT, '.dependency-cruiser.cjs')) as {
    forbidden: { name: string }[];
  };

  function cruise(forbidden: readonly { name: string }[], planted: string) {
    const root = mkdtempSync(join(tmpdir(), 't3b-cruise-'));
    try {
      writeFileSync(
        join(root, '.dependency-cruiser.cjs'),
        `module.exports = ${JSON.stringify({ ...config, forbidden })};\n`,
      );
      const files: Record<string, string> = {
        [FIXTURE_REPORTER]: 'export const R = { observe: () => null };\n',
        'apps/api/server.ts': planted,
      };
      for (const [path, contents] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), contents);
      }
      const run = spawnSync(
        process.execPath,
        [join(ROOT, 'scripts/deps-cruise.mjs'), 'apps', 'tests'],
        { env: { ...process.env, DEPS_CRUISE_ROOT: root }, encoding: 'utf8' },
      );
      return { status: run.status, output: `${run.stdout}${run.stderr}` };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const PLANTED = "import { R } from '../../tests/support/declining-reporter.ts';\nR;\n";

  it('names the declining reporter in its own rule', () => {
    expect(config.forbidden.map((rule) => rule.name)).toContain(RULE);
  });

  it('fires on the API importing the reporter with the general tests/ rule deleted', () => {
    const without = config.forbidden.filter(
      (rule) => rule.name !== 'shippable-never-reaches-tests',
    );
    const answer = cruise(without, PLANTED);
    expect(answer.status).toBe(1);
    expect(answer.output).toContain(RULE);
  });

  it('is green when nothing shippable imports it', () => {
    const answer = cruise(config.forbidden, 'export const api = 1;\n');
    expect(answer.output).toContain('the structural rules hold');
    expect(answer.status).toBe(0);
  });
});
