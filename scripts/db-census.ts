// SPDX-License-Identifier: AGPL-3.0-only
// The census of the database run's splits: that the shards lose nothing.
//
// CI-SPEED (the owner, 4 October 2026, NATHAN-CF-RECORD item 1) took the
// `database conformance` run from 8 shards to 16 on the condition that no
// suite, check or test is lost. Splitting a gate is how a suite drops out
// quietly, so this counts, on one tree, what each split holds: every run item
// placed once, none twice, none that is not an item, and the number of tests
// the placed items hold. The test counts are vitest's own: `vitest list` over
// every named suite, and over each part of a split suite with its SUITE_PART,
// without running anything.
//
// Usage: node scripts/db-census.ts [8 16 ...]
//   Prints one line per split and exits 1 unless every split holds every item
//   once, nothing else, and the same test total. Run it where the database
//   suites are collected as CI collects them: with DATABASE_URL set, since
//   vitest.config.ts leaves some named suites out without one.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { assignShards, itemOf, planItems, readPlan } from './db-shards.ts';
import { readNamedSuites } from './named-suites.ts';

export interface Census {
  /** Run items the manifest and plan make. */
  readonly items: number;
  /** Run items found in some shard. */
  readonly placed: number;
  readonly missing: readonly string[];
  readonly twice: readonly string[];
  /** Entries in a shard that are no run item. */
  readonly extra: readonly string[];
  /** Tests the shards hold between them, each entry counted where it is placed. */
  readonly tests: number;
}

export function censusOf(
  items: readonly string[],
  shards: readonly (readonly string[])[],
  counts: Readonly<Record<string, number>>,
): Census {
  const wanted = new Set(items);
  const seen = new Map<string, number>();
  for (const item of shards.flat()) seen.set(item, (seen.get(item) ?? 0) + 1);
  const placed = [...seen.keys()].filter((item) => wanted.has(item));
  return {
    items: wanted.size,
    placed: placed.length,
    missing: items.filter((item) => !seen.has(item)),
    twice: placed.filter((item) => (seen.get(item) ?? 0) > 1),
    extra: [...seen.keys()].filter((item) => !wanted.has(item)),
    tests: shards.flat().reduce((sum, item) => sum + (counts[item] ?? 0), 0),
  };
}

const root = resolve(import.meta.dirname, '..');

/** Tests per file, as `vitest list` collects `files` with SUITE_PART set to `part`. */
function listed(files: readonly string[], part = ''): Map<string, number> {
  const dir = mkdtempSync(join(tmpdir(), 'db-census-'));
  try {
    const out = join(dir, 'list.json');
    const run = spawnSync(
      process.execPath,
      [join(root, 'node_modules/vitest/vitest.mjs'), 'list', `--json=${out}`, ...files],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, SUITE_PART: part },
        maxBuffer: 256 * 1024 * 1024,
      },
    );
    if (run.status !== 0 || !existsSync(out)) {
      const said = `${run.error?.message ?? ''}${run.stdout}${run.stderr}`.slice(-4000);
      throw new Error(`vitest list failed (${String(run.status ?? run.signal)}): ${said}`);
    }
    const tests = JSON.parse(readFileSync(out, 'utf8')) as { file: string }[];
    const counts = new Map<string, number>();
    for (const { file } of tests) {
      const path = relative(root, file);
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    return counts;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every run item's test count; vitest reads a path as a substring, so each count is the exact file's. */
function countItems(items: readonly string[]): Record<string, number> {
  const whole = items.filter((item) => itemOf(item).part === undefined);
  const all = listed(whole);
  const counts: Record<string, number> = {};
  for (const item of items) {
    const { suite, part } = itemOf(item);
    counts[item] =
      part === undefined ? (all.get(suite) ?? 0) : (listed([suite], part).get(suite) ?? 0);
  }
  return counts;
}

if (import.meta.main) {
  const splits = process.argv.slice(2).map(Number);
  const manifest = readNamedSuites(root);
  const named = [...manifest.invariant, ...manifest.conformance];
  const plan = readPlan(join(root, 'tests/db/shard-plan.json'));
  const items = planItems(named, plan.parts);
  const counts = countItems(items);
  const empty = items.filter((item) => counts[item] === 0);
  console.log(
    `db-census: ${String(new Set(named).size)} named suite(s), ${String(items.length)} run item(s), ` +
      `${String(Object.values(counts).reduce((sum, n) => sum + n, 0))} test(s) listed`,
  );
  const results = (splits.length > 0 ? splits : [8, 16]).map((n) => {
    const census = censusOf(items, assignShards(items, plan.seconds, n), counts);
    console.log(
      `db-census: ${String(n)} shards hold ${String(census.placed)} of ${String(census.items)} ` +
        `item(s), ${String(census.tests)} test(s); missing ${String(census.missing.length)}, ` +
        `twice ${String(census.twice.length)}, extra ${String(census.extra.length)}`,
    );
    return census;
  });
  const sound = results.every(
    (c) =>
      c.placed === c.items &&
      c.missing.length + c.twice.length + c.extra.length === 0 &&
      c.tests === results[0]?.tests,
  );
  for (const item of empty) console.error(`db-census: vitest listed no test in ${item}`);
  if (!sound || empty.length > 0) process.exit(1);
  console.log('db-census: every split holds every item once and the same tests.');
}
