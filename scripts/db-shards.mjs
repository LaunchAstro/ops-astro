// SPDX-License-Identifier: AGPL-3.0-only
// Which named suites each `database conformance` shard runs.
//
// Run one after another the named suites took 40 to 50 minutes on a hosted
// runner, so ci.yml runs them as a matrix of shards, each against its own
// Postgres, and an aggregate job keeps the required check's name. The runner
// (`--shard i/n`) and tests/ci/db-shards.test.ts both take the split from
// here, so the test proves the split the job runs: every named suite in
// exactly one shard.
//
// tests/db/shard-plan.json holds two things. `seconds` is each run item's time
// from a hosted run; an item with no timing weighs the median of those that
// have one, so a suite added to the manifest is assigned without anyone
// editing the plan, and the timings only keep the balance. `parts` names the
// suites too long for one shard: such a suite runs as k items, `<path>#i/k`,
// each with SUITE_PART=i/k, and the suite registers only the cases `inPart`
// gives that part, so every case still runs once, in one part.

import { readFileSync } from 'node:fs';

/** "i/n" to { index, count }, refusing anything that is not 1 <= i <= n. */
export const parseShard = (text, what = '--shard') => {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(String(text));
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (match === null || index > count) {
    throw new Error(`${what} takes i/n with 1 <= i <= n, not "${String(text)}"`);
  }
  return { index, count };
};

/** The plan: suites run in parts, and the recorded seconds per run item. */
export const readPlan = (path) => {
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  return { parts: plan.parts ?? {}, seconds: plan.seconds ?? {} };
};

/** The run items: each named suite, or its k parts when the plan splits it. */
export const planItems = (named, parts) =>
  named.flatMap((suite) => {
    if (!Object.hasOwn(parts, suite)) return [suite];
    const count = parts[suite];
    if (!Number.isInteger(count) || count < 2) {
      throw new Error(`shard plan: ${suite} has ${String(count)} parts; a split needs 2 or more`);
    }
    return Array.from({ length: count }, (_, i) => `${suite}#${String(i + 1)}/${String(count)}`);
  });

/** A run item back to its suite path and, for a part, its "i/k". */
export const itemOf = (item) => {
  const [suite = '', part] = item.split('#');
  return { suite, part };
};

/** The part a suite is running as: SUITE_PART, or the whole suite when unset. */
export const suitePart = (text) =>
  text === undefined || text === '' ? { index: 1, count: 1 } : parseShard(text, 'SUITE_PART');

/** Whether the case at this index belongs to the part. */
export const inPart = (index, part) => index % part.count === part.index - 1;

/**
 * The run items split into `count` shards: longest first onto the shard
 * with the least time so far, the lower shard on a tie. Each shard keeps the
 * manifest's order, and the result depends only on its inputs, so every shard
 * of a run computes the same split.
 */
export const assignShards = (items, seconds, count) => {
  const known = Object.values(seconds)
    .filter((n) => typeof n === 'number' && n > 0)
    .toSorted((a, b) => a - b);
  const fallback = known.length > 0 ? known[Math.floor(known.length / 2)] : 1;
  const weight = (item) => {
    const n = Object.hasOwn(seconds, item) ? seconds[item] : undefined;
    return typeof n === 'number' && n > 0 ? n : fallback;
  };
  const weighed = items
    .map((item, index) => ({ item, index, weight: weight(item) }))
    .toSorted((a, b) => b.weight - a.weight || a.index - b.index);
  const shards = Array.from({ length: count }, () => ({ load: 0, items: [] }));
  for (const entry of weighed) {
    const least = shards.reduce((best, shard) => (shard.load < best.load ? shard : best));
    least.load += entry.weight;
    least.items.push(entry);
  }
  return shards.map((shard) =>
    shard.items.toSorted((a, b) => a.index - b.index).map((entry) => entry.item),
  );
};
