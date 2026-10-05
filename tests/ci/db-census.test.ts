// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-SPEED (NATHAN-CF-RECORD item 1): the database run went from 8 shards to
// 16, and the owner's condition was that nothing is lost on the way. A split is
// how a suite drops out quietly, so `scripts/db-census.ts` counts what each
// split holds: every run item placed once, none twice, none extra, and the
// same number of tests whatever the number of shards. This holds the counting
// to cases; the census itself runs over vitest's own list of each item.

import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { censusOf } from '../../scripts/db-census.ts';
import { assignShards, planItems, readPlan } from '../../scripts/db-shards.ts';
import { readNamedSuites } from '../../scripts/named-suites.ts';

const manifest = readNamedSuites(fileURLToPath(new URL('../..', import.meta.url)));
const plan = readPlan(new URL('../../tests/db/shard-plan.json', import.meta.url));
const items = planItems([...manifest.invariant, ...manifest.conformance], plan.parts);
/** A made-up test count per item, uneven so a lost or doubled item moves the total. */
const counts = Object.fromEntries(items.map((item, i) => [item, (i % 7) + 1]));
const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

it('the 8- and 16-way splits hold every item once and the same test total', () => {
  const eight = censusOf(items, assignShards(items, plan.seconds, 8), counts);
  const sixteen = censusOf(items, assignShards(items, plan.seconds, 16), counts);
  for (const census of [eight, sixteen]) {
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
  const [first = [], second = [], ...rest] = assignShards(items, plan.seconds, 16);
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
