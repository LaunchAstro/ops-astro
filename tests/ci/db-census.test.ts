// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-SPEED (NATHAN-CF-RECORD item 1) took the database run from 8 shards to
// 16, CIITEM3 (12 October 2026) from 16 to 30 and RELAYSHARD1830 (13 October
// 2026) from 30 to 12, and the condition each time was that nothing is lost
// on the way. A split is
// how a suite drops out quietly, so `scripts/db-census.ts` counts what each
// split holds: every run item placed once, none twice, none extra, and the
// same number of tests whatever the number of shards. This holds the counting
// to cases; the census itself runs over vitest's own list of each item.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { censusOf } from '../../scripts/db-census.ts';
import { assignShards, planItems, readPlan } from '../../scripts/db-shards.ts';
import { readNamedSuites } from '../../scripts/named-suites.ts';
import { ci, ISOLATION_COUNT } from './ci-shards.fixture.ts';
import { ROOT } from './merge-group-repo.ts';

const manifest = readNamedSuites(fileURLToPath(new URL('../..', import.meta.url)));
const plan = readPlan(new URL('../../tests/db/shard-plan.json', import.meta.url));
const items = planItems([...manifest.invariant, ...manifest.conformance], plan.parts);
/** A made-up test count per item, uneven so a lost or doubled item moves the total. */
const counts = Object.fromEntries(items.map((item, i) => [item, (i % 7) + 1]));
const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

it('the 12-, 16- and 30-way splits hold every item once and the same test total', () => {
  const twelve = censusOf(items, assignShards(items, plan.seconds, 12), counts);
  const sixteen = censusOf(items, assignShards(items, plan.seconds, 16), counts);
  const thirty = censusOf(items, assignShards(items, plan.seconds, 30), counts);
  for (const census of [twelve, sixteen, thirty]) {
    expect(census).toStrictEqual({
      items: items.length,
      placed: items.length,
      missing: [],
      twice: [],
      extra: [],
      tests: total,
    });
  }
});

it('names an item a split lost, repeated or made up, and the total moves', () => {
  const [first = [], second = [], ...rest] = assignShards(items, plan.seconds, 30);
  const lost = first[0] ?? '';
  const doubled = second[0] ?? '';
  const planted = [[...first.slice(1), doubled, 'tests/made-up.test.ts'], second, ...rest];
  const census = censusOf(items, planted, counts);
  expect(census.missing).toStrictEqual([lost]);
  expect(census.twice).toStrictEqual([doubled]);
  expect(census.extra).toStrictEqual(['tests/made-up.test.ts']);
  expect(census.placed).toBe(items.length - 1);
  expect(census.tests).toBe(total - (counts[lost] ?? 0) + (counts[doubled] ?? 0));
});

/** What one shard's runner would run, from its own `--list`. */
const listed = (args: readonly string[]): string[] => {
  const run = spawnSync(process.execPath, ['scripts/db-conformance.mjs', ...args, '--list'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: 'postgres://unused@127.0.0.1:1/x' },
  });
  // --list runs nothing, so it never exits 0.
  expect(run.status, run.stderr).toBe(3);
  return run.stdout.split('\n').filter(Boolean);
};

// A merge group runs the named suites in two matrices: `database conformance`
// and `isolation tests`. Between them every run item runs once, so neither
// matrix repeats the other's suites, and none is left out.
it('the database and isolation shards run every named item exactly once a group', () => {
  const database = ci.jobs['database-shard']?.strategy?.matrix?.shard?.length ?? 0;
  expect(database).toBeGreaterThan(0);
  const shards = (count: number, flags: readonly string[]): string[][] =>
    Array.from({ length: count }, (_, i) =>
      listed([...flags, '--shard', `${String(i + 1)}/${String(count)}`]),
    );
  // The database shards' own command leaves the isolation suites out.
  const command = ci.jobs['database-shard']?.steps?.find((step) =>
    step.run?.includes('db:conformance'),
  )?.run;
  expect(command).toContain('--without-isolation');
  const group = [
    ...shards(database, ['--without-isolation']),
    ...shards(ISOLATION_COUNT, ['--isolation']),
  ];
  expect(censusOf(items, group, counts)).toStrictEqual({
    items: items.length,
    placed: items.length,
    missing: [],
    twice: [],
    extra: [],
    tests: total,
  });
}, 180_000);

it('the runner refuses to run the isolation suites and leave them out at once', () => {
  const run = spawnSync(
    process.execPath,
    ['scripts/db-conformance.mjs', '--isolation', '--without-isolation', '--list'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: 'postgres://unused@127.0.0.1:1/x' },
    },
  );
  expect(run.status).toBe(2);
  expect(run.stderr).toContain('--isolation and --without-isolation do not go together');
});
