// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proofs from review round 1 of #1833 (#1753), copied under the names of
// what they prove. The first schedules each database shard as the runner does:
// the next item in the runner's lane order (scripts/db-shards.ts `laneOrder`)
// to the first free of three lanes. Sol's copy took them in manifest order,
// which the runner then did, and nine shards came to 538 to 570 s. The second
// reads the isolation shards' job bound, now ten minutes. Main has run 13 database
// shards since DIRSHARD13 (19 October), so the first splits the plan 13 ways.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  assignShards,
  databaseItems,
  laneOrder,
  planItems,
  readPlan,
  shardWeight,
} from '../../scripts/db-shards.ts';
import { readIsolationSuites, readNamedSuites } from '../../scripts/named-suites.ts';

const root = resolve(import.meta.dirname, '../..');

it('every database shard, run in three lanes in the runner’s order, fits nine minutes of wall time', () => {
  const plan = readPlan(join(root, 'tests/db/shard-plan.json'));
  const named = readNamedSuites(root);
  const items = databaseItems(
    planItems([...named.invariant, ...named.conformance], plan.parts),
    readIsolationSuites(root).invariant,
  );
  const weight = shardWeight(plan.seconds);
  const walls = assignShards(items, plan.seconds, 13).map((shard) => {
    const lanes = [0, 0, 0];
    // The runner gives the next item in its lane order to the first free lane.
    for (const index of laneOrder(shard, plan.seconds)) {
      const lane = lanes.indexOf(Math.min(...lanes));
      lanes[lane] = (lanes[lane] ?? 0) + weight(shard[index] ?? '');
    }
    return Math.max(...lanes) * 1.3;
  });
  expect(Math.max(...walls), JSON.stringify(walls)).toBeLessThanOrEqual(540);
});

it('an isolation shard’s job is bounded at ten minutes', () => {
  const source = readFileSync(join(root, 'tests/ci/ci-shards.test.ts'), 'utf8');
  const match = /const ISOLATION_JOB_SECONDS = (\d+) \* 60;/u.exec(source);
  expect(match).not.toBeNull();
  expect(Number(match?.[1]) * 60).toBeLessThanOrEqual(600);
});
