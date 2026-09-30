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
// The split is by measured time: tests/db/suite-timings.json holds each
// suite's seconds from a hosted run. A suite with no timing weighs the median
// of those that have one, so a suite added to the manifest is assigned
// without anyone editing the timings; the timings only keep the balance.

import { readFileSync } from 'node:fs';

/** "i/n" to { index, count }, refusing anything that is not 1 <= i <= n. */
export const parseShard = (text) => {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(String(text));
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (match === null || index > count) {
    throw new Error(`--shard takes i/n with 1 <= i <= n, not "${String(text)}"`);
  }
  return { index, count };
};

/** The recorded seconds per suite path. */
export const readTimings = (path) => JSON.parse(readFileSync(path, 'utf8')).seconds ?? {};

/**
 * The named suites split into `count` shards: longest first onto the shard
 * with the least time so far, the lower shard on a tie. Each shard keeps the
 * manifest's order, and the result depends only on its inputs, so every shard
 * of a run computes the same split.
 */
export const assignShards = (named, timings, count) => {
  const known = Object.values(timings)
    .filter((n) => typeof n === 'number' && n > 0)
    .toSorted((a, b) => a - b);
  const fallback = known.length > 0 ? known[Math.floor(known.length / 2)] : 1;
  const weight = (suite) => {
    const n = Object.hasOwn(timings, suite) ? timings[suite] : undefined;
    return typeof n === 'number' && n > 0 ? n : fallback;
  };
  const items = named
    .map((suite, index) => ({ suite, index, weight: weight(suite) }))
    .toSorted((a, b) => b.weight - a.weight || a.index - b.index);
  const shards = Array.from({ length: count }, () => ({ load: 0, items: [] }));
  for (const item of items) {
    const least = shards.reduce((best, shard) => (shard.load < best.load ? shard : best));
    least.load += item.weight;
    least.items.push(item);
  }
  return shards.map((shard) =>
    shard.items.toSorted((a, b) => a.index - b.index).map((item) => item.suite),
  );
};
