// SPDX-License-Identifier: AGPL-3.0-only
// `database conformance` runs its named suites across matrix shards,
// each with its own Postgres, all but the isolation suites, which the
// `isolation tests` shards run. Splitting a gate is how a suite gets dropped
// quietly, so this proves the split runs every suite once: the shards' lists
// put together are the manifest's list less the isolation suites (the two
// matrices together are the whole list, tests/ci/db-census.test.ts), no suite
// is in two shards, a suite
// named later lands in a shard without anyone editing the timings, a suite
// split into parts runs each case in exactly one part, and the aggregate keeps
// the required check's name and fails unless every shard passed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  assignShards,
  databaseItems,
  inPart,
  itemOf,
  parseShard,
  planItems,
  readPlan,
  shardWeight,
  suitePart,
} from '../../scripts/db-shards.ts';
import { readIsolationSuites, readNamedSuites } from '../../scripts/named-suites.ts';
import { unguarded } from './open-pull-request.ts';

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const root = fileURLToPath(new URL('../..', import.meta.url));
const manifest = readNamedSuites(root);
const named = [...manifest.invariant, ...manifest.conformance];
const isolation = readIsolationSuites(root).invariant;
const plan = readPlan(new URL('../../tests/db/shard-plan.json', import.meta.url));
/** The run items these shards split: the manifest's, less the isolation suites'. */
const items = databaseItems(planItems(named, plan.parts), isolation);
const timings = plan.seconds;
const ci = read('.github/workflows/ci.yml');

/** One job's block of ci.yml, from its key to the next job's key. */
function job(key: string): string {
  const start = ci.indexOf(`\n  ${key}:\n`);
  if (start === -1) return '';
  const next = ci.slice(start + 1).search(/\n {2}[\w-]+:\n/u);
  return ci.slice(start + 1, next === -1 ? undefined : start + 1 + next + 1);
}

const shardJob = job('database-shard');
const matrix = /^ {8}shard: \[([\d, ]+)\]$/mu.exec(shardJob)?.[1];
const shardCount = matrix === undefined ? 0 : matrix.split(',').length;

const sorted = (list: readonly string[]) => list.toSorted();

it('the matrix numbers its shards 1 to n, and the runner is told which of n it is', () => {
  expect(shardCount).toBeGreaterThan(1);
  expect(matrix?.split(',').map((n) => Number(n.trim()))).toEqual(
    Array.from({ length: shardCount }, (_, i) => i + 1),
  );
  expect(shardJob).toContain('-- pnpm run db:conformance --shard "$SHARD"');
  expect(shardJob).toContain('SHARD: ${{ matrix.shard }}/${{ strategy.job-total }}');
  expect(shardJob).toContain('fail-fast: false');
  expect(shardJob).toMatch(/image: postgres@sha256:[0-9a-f]{64}/u);
  expect(shardJob).toContain('FIXTURE_PG_CONTAINER: ${{ job.services.postgres.id }}');
});

/** The heaviest shard's load, and the most it may carry: a tenth over its share, or the one item too long to share. */
function balance(
  list: readonly string[],
  seconds: Readonly<Record<string, number>>,
  count: number,
): { heaviest: number; bound: number } {
  const weight = shardWeight(seconds);
  const loads = assignShards(list, seconds, count).map((shard) =>
    shard.reduce((sum, item) => sum + weight(item), 0),
  );
  const total = list.reduce((sum, item) => sum + weight(item), 0);
  const longest = Math.max(...list.map((item) => weight(item)));
  return { heaviest: Math.max(...loads), bound: Math.max(longest, (total / count) * 1.1) };
}

// DIRSHARD14, the director's 28 October 2026 decision: 14 shards (13 under DIRSHARD13,
// 19 October), so a merge group runs about 22 jobs at once and two groups fit the account's 60.
// At most 20 minutes of measured items a shard (13 had reached 20.0 by 28 October), beside about
// a minute of checkout, install and the migrated template, well inside the job's 35-minute limit.
// A plan past it needs more shards or a finer split.
const SHARD_ITEM_SECONDS = 20 * 60;

it('the run is split 14 ways, each shard near its share', () => {
  expect(shardCount).toBe(14);
  const { heaviest, bound } = balance(items, timings, shardCount);
  expect(heaviest).toBeLessThanOrEqual(bound);
  expect(heaviest, 'the heaviest shard, in seconds of measured items').toBeLessThanOrEqual(
    SHARD_ITEM_SECONDS,
  );
});

it('the balance check weighs a suite with no timing as the split does', () => {
  // Every item weighs 10 to the split (the untimed three at the median), so it puts
  // three in each shard: 30 and 30. Weighed at 0 s, one shard reads 20 against a share of 15.
  const { heaviest, bound } = balance(
    ['a', 'b', 'c', 'u1', 'u2', 'u3'],
    { a: 10, b: 10, c: 10 },
    2,
  );
  expect(heaviest).toBeLessThanOrEqual(bound);
});

it('every run item runs in exactly one shard, and the shards together are the manifest less the isolation suites', () => {
  const shards = assignShards(items, timings, shardCount);
  expect(shards).toHaveLength(shardCount);
  for (const shard of shards) expect(shard.length).toBeGreaterThan(0);
  expect(sorted(shards.flat())).toEqual(sorted(items));
  // Every named suite but an isolation suite is an item, or all k of its parts are.
  expect(sorted([...new Set(items.map((item) => itemOf(item).suite))])).toEqual(
    sorted([...new Set(named)].filter((suite) => !isolation.includes(suite))),
  );
  for (const [suite, count] of Object.entries(plan.parts)) {
    if (isolation.includes(suite)) continue;
    expect(named, `${suite} is split but not named`).toContain(suite);
    expect(items.filter((item) => itemOf(item).suite === suite).map((i) => itemOf(i).part)).toEqual(
      Array.from({ length: count }, (_, i) => `${String(i + 1)}/${String(count)}`),
    );
  }
  const seen = new Map<string, number>();
  shards.forEach((shard, i) => {
    for (const suite of shard) {
      expect(
        seen.get(suite),
        `${suite} in shards ${String(seen.get(suite))} and ${String(i)}`,
      ).toBeUndefined();
      seen.set(suite, i);
    }
  });
});

it('a suite named later is assigned to one shard without a timing of its own', () => {
  const added = 'tests/db/named-later.test.ts';
  const shards = assignShards([...items, added], timings, shardCount);
  expect(shards.filter((shard) => shard.includes(added))).toHaveLength(1);
  expect(sorted(shards.flat())).toEqual(sorted([...items, added]));
});

it('the split is balanced by measured time, not by count', () => {
  const shards = assignShards(['a', 'b', 'c', 'd'], { a: 90, b: 10, c: 10, d: 10 }, 2);
  expect(shards).toEqual([['a'], ['b', 'c', 'd']]);
  // Each shard keeps the manifest's order.
  expect(assignShards(['z', 'y', 'x'], {}, 1)).toEqual([['z', 'y', 'x']]);
});

it('a split suite runs each case in exactly one part, and the whole suite when unset', () => {
  for (const count of [...Object.values(plan.parts), 2, 7]) {
    for (const cases of [1, 7, 63, 2835]) {
      const owners = Array.from({ length: cases }, (_, i) =>
        Array.from({ length: count }, (__, p) => p + 1).filter((index) =>
          inPart(i, { index, count }),
        ),
      );
      expect(owners.filter((o) => o.length !== 1)).toEqual([]);
    }
  }
  expect(suitePart(process.env['SUITE_PART_UNSET_HERE'])).toEqual({ index: 1, count: 1 });
  expect(suitePart('')).toEqual({ index: 1, count: 1 });
  expect(suitePart('2/6')).toEqual({ index: 2, count: 6 });
  expect(() => suitePart('7/6')).toThrow();
  expect(() => planItems(['a'], { a: 1 })).toThrow();
  // The split suite takes its part from SUITE_PART and runs only its cells.
  const d06 = read('tests/acceptance/d06-generated.test.ts');
  expect(Object.keys(plan.parts)).toEqual([
    'tests/acceptance/d06-generated.test.ts',
    'tests/acceptance/d06-agent.test.ts',
    'tests/tenancy/restricted-calls-prefixes.test.ts',
  ]);
  // So does the agent prefix's, on both of its lists, through its fixture.
  const agent = read('tests/acceptance/d06-agent.test.ts');
  expect(agent).toContain('it.each(ofThisPart(cells))(');
  expect(agent).toContain('it.each(ofThisPart(excluded))(');
  const fixture = read('tests/acceptance/d06-agent-fixture.ts');
  expect(fixture).toContain("const part = suitePart(process.env['SUITE_PART']);");
  expect(fixture).toContain('return list.filter((_, i) => inPart(i, part));');
  expect(d06).toContain("const PART = suitePart(process.env['SUITE_PART']);");
  expect(d06).toContain('TOP_LEVEL_CELLS.filter((_, i) => inPart(i, PART))');
  expect(d06).toContain('PAYLOAD_CELLS.filter((_, i) => inPart(i, PART))');
  expect(d06).toContain('it.each(TOP_CELLS)(');
  expect(d06).toContain('it.each(FIELD_CELLS)(');
  expect(d06).toContain('expect(tally.total()).toBe(TOP_CELLS.length + FIELD_CELLS.length);');
  // The prefix suite applies every migration in each part and proves only its share.
  const prefixes = read('tests/tenancy/restricted-calls-prefixes.test.ts');
  expect(prefixes).toContain("const PART = suitePart(process.env['SUITE_PART']);");
  expect(prefixes).toContain('if (!inPart(index, PART)) continue;');
  expect(prefixes).toContain('await catchUpTo(index);');
});

it('a shard argument that is not i of n is refused', () => {
  expect(parseShard('3/8')).toEqual({ index: 3, count: 8 });
  for (const bad of ['0/8', '9/8', '8', '1/1/1', 'a/8', '1/0', ' 1/8', '1.5/8', '-1/8', ''])
    expect(() => parseShard(bad), bad).toThrow();
});

it('the aggregate keeps the name and fails unless every shard succeeded', () => {
  const aggregate = job('database');
  expect(aggregate).toContain('    name: database conformance\n');
  // It needs the gate too, and reads its result: a pull request whose gate failed skips the
  // shards, and that skip must not pass (tests/ci/light-pull-requests-workflow.test.ts).
  expect(aggregate).toContain('    needs: [gate, full, database-shard, isolation]\n');
  expect(aggregate).toContain('GATE: ${{ needs.gate.result }}');
  // Without always() a failed or skipped shard would skip this job, and a
  // skipped required check reads as passed.
  // The exact guard against closed pull requests aside (open-pull-request.ts).
  expect(unguarded(/^ {4}if: (.+)$/mu.exec(aggregate)?.[1])).toBe('always()');
  expect(aggregate).toContain('SHARDS: ${{ needs.database-shard.result }}');
  expect(aggregate).toContain('test "$SHARDS" = success');
  // The isolation suites run in the isolation shards alone, so the aggregate reads them too.
  expect(aggregate).toContain('ISOLATION: ${{ needs.isolation.result }}');
  expect(aggregate).toContain('test "$ISOLATION" = success');
  expect(aggregate).not.toMatch(/continue-on-error/u);
  expect(shardJob).not.toMatch(/continue-on-error/u);
});
